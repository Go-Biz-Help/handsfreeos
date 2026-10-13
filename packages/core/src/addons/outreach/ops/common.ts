/**
 * What Social Outreach's commands and queries share (server-only): the business they run in, the profiles that tie
 * someone to a social network, where the person's own Facebook stands with them, and who's never pitched. Row
 * security decides what a request sees.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { people, recordTags, tags } from '@hfos/db/schema';
import { fullName, requirePerson, userRef } from '../../../crm/records';
import { personCreate } from '../../../commands/person.create';
import { splitName } from '../../../inbox/contact';
import { userIdOf } from '../../../kernel/actor';
import { HfosError } from '../../../errors';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { addonTimelineLine } from '../../server';
import { outreachSettings } from '../chat-read';
import { countryRuleOn, type CountryRule } from '../countries';
import type { DontPitch } from '../friends';
import { DONT_PITCH_TAG, MESSAGE_MOST, type FriendState } from '../limits';
import { outreachAddon } from '../manifest';
import { PLATFORMS, type Platform } from '../playbooks';
import type { Friendship } from '../saves';
import { RECENT_SHOWN, type RecentMessage } from '../sends';
import { friends, profiles } from '../tables';

export type Ctx = CommandContext | QueryContext;

/**
 * Whether whoever asks sees the whole team's outreach: an owner or admin (`outreach.manage`), or the worker asking for
 * one (the weekly report).
 */
export async function seesEveryone(ctx: Ctx, me: string): Promise<boolean> {
  if (scopeCan(ctx.scope, 'outreach.manage' as Permission)) return true;
  if (ctx.actor.type !== 'system') return false;
  const [can] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select true as ok from app.workspace_access
        where workspace_id = ${ctx.scope.workspaceId} and user_id = ${me}
          and 'outreach.manage' = any (permissions)`,
  );
  return !!can;
}
export type Profile = typeof profiles.$inferSelect;
type ProfileRow = typeof profiles.$inferInsert;

/** A profile's name as two are compared: one space between words, no capitals. `p` is its alias. */
const nameKeyOf = (p: string) =>
  sql`lower(regexp_replace(btrim(${sql.raw(p)}.name), '[[:space:]]+', ' ', 'g'))`;

/** A profile marked never pitched itself: on Don't pitch, or a customer tagged Friend or family. `p` is its alias. */
export const markedNever = (p: string) => sql`(${sql.raw(p)}.dont_pitch or exists (
  select 1 from app.record_tags rt join app.tags tg on tg.id = rt.tag_id
  where rt.record_type = 'person' and rt.record_id = ${sql.raw(p)}.person_id
    and lower(tg.name::text) = lower(${DONT_PITCH_TAG})))`;

/**
 * The other profiles kept under the same name on the same network that are marked never pitched, as `twin`. Facebook
 * shows one person by number in one place and by username in another, so the same person can be kept twice, and Don't
 * pitch on one covers the other. A stranger who shares the name is left alone too: the safe side. `p` is its alias.
 */
export const neverTwins = (p: string) => sql`select twin.* from addon_outreach.profiles twin
  where twin.workspace_id = ${sql.raw(p)}.workspace_id and twin.platform = ${sql.raw(p)}.platform
    and twin.id <> ${sql.raw(p)}.id and ${nameKeyOf('twin')} = ${nameKeyOf(p)} and ${markedNever('twin')}`;

/** A profile that's pitched: neither it nor a twin of it (`neverTwins`) is marked never pitched. `p` is its alias. */
export const pitchable = (p: string) =>
  sql`not ${markedNever(p)} and not exists (${neverTwins(p)})`;

/**
 * A profile still in play for the person `me` (decision 47): not marked not a fit, by them or by the AI's read of their
 * chat. "Not interested" ends outreach for good, until they put them back in play. `p` is its alias.
 */
export const inPlay = (me: string, p: string) => sql`not exists (
  select 1 from addon_outreach.stages st
  where st.profile_id = ${sql.raw(p)}.id and st.user_id = ${me} and st.mark = 'lost')`;

/** The business's country setting (decision 61), as it's read: Anywhere when it isn't set. */
export async function countryRuleOf(ctx: Ctx): Promise<CountryRule> {
  const [installed] = await rows<{ settings: unknown }>(
    ctx.tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = ${outreachAddon.id}`,
  );
  return outreachSettings(installed?.settings).countries;
}

/**
 * A profile the business's country setting lets be reached (decision 61, `countryLets` in ../countries.ts, the one
 * copy of the rule): let through with Unskip, its country not known, or in (or not in) the countries picked. `p` is
 * its alias, any row with `country` and `country_through`.
 */
export function countryLetsSql(rule: CountryRule, p: string) {
  if (!countryRuleOn(rule)) return sql`true`;
  const a = sql.raw(p);
  const codes = `{${rule.codes.join(',')}}`;
  return rule.mode === 'only'
    ? sql`(${a}.country_through or ${a}.country is null or ${a}.country = any (${codes}::text[]))`
    : sql`(${a}.country_through or ${a}.country is null or not (${a}.country = any (${codes}::text[])))`;
}

export const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/**
 * Two saves of a new profile, group or chat at the same moment: the second is asked to go again, and then finds the
 * first.
 */
export async function once<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (isUniqueViolation(e))
      throw HfosError.rule(
        'outreach_saved_at_once',
        409,
        'This was being saved twice at the same moment. Save it again.',
      );
    throw e;
  }
}

/** Where a customer saved from a social network says they came from. */
export const sourceFor = (platform: Platform): string => PLATFORMS[platform];

/** A profile's number and username, as a page's links showed them. */
export interface ProfileKey {
  readonly id: string | null;
  readonly username: string | null;
}

/**
 * The profiles saved here that a page's profile is: by its number, or by its username. Two can come back when a
 * profile was saved once by each; the one by number comes first, since a username can change hands and a number can't.
 */
export async function profilesFor(
  ctx: Ctx,
  platform: Platform,
  key: ProfileKey,
): Promise<Profile[]> {
  const by = [
    ...(key.id ? [eq(profiles.platformId, key.id)] : []),
    ...(key.username ? [sql`lower(${profiles.username}) = lower(${key.username})`] : []),
  ];
  if (!by.length) return [];
  const found = await ctx.tx
    .select()
    .from(profiles)
    .where(
      and(
        eq(profiles.workspaceId, ctx.scope.workspaceId!),
        eq(profiles.platform, platform),
        or(...by),
      ),
    );
  return found.sort((a, b) => Number(b.platformId === key.id) - Number(a.platformId === key.id));
}

/** What a profile page said about someone; a chat says only who it's with. */
export interface ProfileFacts {
  readonly intro: readonly string[];
  readonly friendship: Friendship;
  readonly mutualFriends: number | null;
}

export interface SavedProfile {
  readonly profileId: string;
  readonly personId: string;
  readonly personName: string;
  readonly addedPerson: boolean;
}

/**
 * The customer a social profile belongs to, saving the profile on the way: the one it's saved to already, the one
 * the person picked (moving the profile to them), or a new customer from the profile's name, with the network as
 * their source and texting consent left unknown. Writes the customer's timeline line when the profile is new to them.
 */
export async function saveProfile(
  ctx: CommandContext,
  input: {
    readonly platform: Platform;
    readonly profile: ProfileKey & { readonly url: string };
    readonly name: string;
    readonly facts: ProfileFacts | null;
    readonly personId?: string;
  },
): Promise<SavedProfile> {
  const ws = ctx.scope.workspaceId!;
  const at = changeMoment(ctx.meta);
  const me = userIdOf(ctx.actor);
  const found = await profilesFor(ctx, input.platform, input.profile);
  const had = found[0] ?? null;

  let personId = input.personId ?? had?.personId ?? null;
  let addedPerson = false;
  if (input.personId) await requirePerson(ctx.tx, ws, input.personId);
  if (!personId) {
    const { firstName, lastName } = splitName(input.name);
    personId = (
      await executeCommandWithin(ctx, personCreate, {
        workspaceId: ws,
        firstName: firstName.slice(0, 80),
        lastName: lastName.slice(0, 80),
        source: sourceFor(input.platform),
        ignoreDuplicates: true,
      })
    ).output.personId;
    addedPerson = true;
  }

  const facts = input.facts
    ? {
        intro: [...input.facts.intro],
        friendship: input.facts.friendship,
        mutualFriends: input.facts.mutualFriends,
      }
    : {};
  let profileId: string;
  if (had) {
    // A later look fills in the number or username the first one didn't show, unless another saved profile has it.
    const other = found.length > 1;
    await ctx.tx
      .update(profiles)
      .set({
        personId,
        url: input.profile.url,
        name: input.name,
        ...(!had.platformId && input.profile.id && !other ? { platformId: input.profile.id } : {}),
        ...(!had.username && input.profile.username && !other
          ? { username: input.profile.username }
          : {}),
        ...facts,
        lastSeenBy: me,
        lastSeenAt: at,
      })
      .where(eq(profiles.id, had.id));
    profileId = had.id;
  } else {
    const [row] = await ctx.tx
      .insert(profiles)
      .values({
        workspaceId: ws,
        personId,
        platform: input.platform,
        platformId: input.profile.id,
        username: input.profile.username,
        url: input.profile.url,
        name: input.name,
        ...facts,
        savedBy: me,
        lastSeenBy: me,
        lastSeenAt: at,
      })
      .returning({ id: profiles.id });
    profileId = row!.id;
  }

  if (!had || had.personId !== personId)
    await addonTimelineLine(ctx, outreachAddon, {
      personId,
      words: addedPerson
        ? `added them from ${PLATFORMS[input.platform]}`
        : `linked their ${PLATFORMS[input.platform]} profile`,
      body: input.profile.url,
    });

  const [person] = await ctx.tx
    .select({ firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(eq(people.id, personId));
  return {
    profileId,
    personId,
    personName: person ? fullName(person.firstName, person.lastName) : input.name,
    addedPerson,
  };
}

/**
 * The profile kept for someone on a network: the one kept already, or a new one with no customer, since noting a
 * step or saving a list adds nobody to Contacts. A later look fills in the number or username the first one didn't
 * show, unless another kept profile has it. `fresh` is what a new one starts with besides, and `then` what to change
 * on one kept already; its name and the rest stay as the last save wrote them.
 */
export async function keptProfile(
  ctx: CommandContext,
  input: {
    readonly platform: Platform;
    readonly profile: ProfileKey & { readonly url: string };
    readonly name: string;
  },
  me: string,
  at: Date,
  fresh: Partial<ProfileRow> = {},
  then?: (had: Profile) => Partial<ProfileRow>,
): Promise<Profile> {
  const found = await profilesFor(ctx, input.platform, input.profile);
  const had = found[0];
  if (!had) {
    const [row] = await ctx.tx
      .insert(profiles)
      .values({
        workspaceId: ctx.scope.workspaceId!,
        personId: null,
        platform: input.platform,
        platformId: input.profile.id,
        username: input.profile.username,
        url: input.profile.url,
        name: input.name,
        ...fresh,
        savedBy: me,
        lastSeenBy: me,
        lastSeenAt: at,
      })
      .returning();
    return row!;
  }
  const only = found.length === 1;
  const change = {
    ...(!had.platformId && input.profile.id && only ? { platformId: input.profile.id } : {}),
    ...(!had.username && input.profile.username && only
      ? { username: input.profile.username }
      : {}),
    ...then?.(had),
  };
  if (!Object.keys(change).length) return had;
  const [row] = await ctx.tx
    .update(profiles)
    .set(change)
    .where(eq(profiles.id, had.id))
    .returning();
  return row!;
}

/** Where the person's own Facebook stood with someone, as the extension saw or noted it. */
export interface FriendSeen {
  readonly profileId: string;
  readonly state: FriendState;
}

/**
 * Where the person's own Facebook stands with some profiles, as seen or noted at `at`. A new state starts its
 * `since`, and the same one seen again only moves `seen_at`. A later look stays when what's sent is older (a step
 * that waited to send), and "not friends" never replaces a request they turned down, which says more. Keep stays as
 * it was. The profiles whose state changed, or that had none.
 */
export async function keepFriendStates(
  ctx: CommandContext,
  me: string,
  seen: readonly FriendSeen[],
  at: Date,
): Promise<Set<string>> {
  const changed = new Set<string>();
  if (!seen.length) return changed;
  const ws = ctx.scope.workspaceId!;
  const had = new Map(
    (
      await ctx.tx
        .select()
        .from(friends)
        .where(
          and(
            eq(friends.workspaceId, ws),
            eq(friends.userId, me),
            inArray(friends.profileId, [...new Set(seen.map((s) => s.profileId))]),
          ),
        )
    ).map((f) => [f.profileId, f]),
  );
  const write = new Map<string, { state: FriendState; since: Date; seenAt: Date }>();
  for (const { profileId, state: seenState } of seen) {
    const was = had.get(profileId);
    if (was && was.seenAt > at) continue;
    const state = was?.state === 'declined' && seenState === 'not_friends' ? 'declined' : seenState;
    if (was?.state !== state) changed.add(profileId);
    write.set(profileId, { state, since: was?.state === state ? was.since : at, seenAt: at });
  }
  if (write.size)
    await ctx.tx
      .insert(friends)
      .values(
        [...write].map(([profileId, row]) => ({ workspaceId: ws, userId: me, profileId, ...row })),
      )
      .onConflictDoUpdate({
        target: [friends.workspaceId, friends.userId, friends.profileId],
        set: {
          state: sql`excluded.state`,
          since: sql`excluded.since`,
          seenAt: sql`excluded.seen_at`,
        },
      });
  return changed;
}

/** The customers among some who are tagged Friend or family in Contacts (DONT_PITCH_TAG), so never pitched. */
export async function taggedFriendOrFamily(
  ctx: Ctx,
  personIds: readonly string[],
): Promise<Set<string>> {
  if (!personIds.length) return new Set();
  const found = await ctx.tx
    .select({ personId: recordTags.recordId })
    .from(recordTags)
    .innerJoin(tags, eq(tags.id, recordTags.tagId))
    .where(
      and(
        eq(recordTags.workspaceId, ctx.scope.workspaceId!),
        eq(recordTags.recordType, 'person'),
        // The name is citext, whose own = isn't on the search path here: compared without capitals instead.
        sql`lower(${tags.name}::text) = lower(${DONT_PITCH_TAG})`,
        inArray(recordTags.recordId, [...personIds]),
      ),
    );
  return new Set(found.map((f) => f.personId));
}

/**
 * Whether someone's never pitched, and why: put on the list here, or tagged Friend or family; or the same goes for
 * their twin, kept under the same name (`neverTwins`). Null when they may be.
 */
export async function dontPitchOf(ctx: Ctx, profile: Profile): Promise<DontPitch | null> {
  const tagged =
    profile.personId !== null &&
    (await taggedFriendOrFamily(ctx, [profile.personId])).has(profile.personId);
  if (!profile.dontPitch && !tagged) {
    const [twin] = await rows<{ dont_pitch: boolean; by: string | null; at: Date | string | null }>(
      ctx.tx,
      sql`select tw.dont_pitch, tw.dont_pitch_at as at,
            coalesce(nullif(u.full_name, ''), u.email::text) as by
          from addon_outreach.profiles p
          cross join lateral (${neverTwins('p')} order by twin.dont_pitch desc limit 1) tw
          left join app.users u on u.id = tw.dont_pitch_by
          where p.id = ${profile.id}`,
    );
    if (!twin) return null;
    return twin.dont_pitch
      ? {
          by: twin.by,
          at: twin.at === null ? null : new Date(twin.at).toISOString(),
          tagged: false,
        }
      : { by: null, at: null, tagged: true };
  }
  const by =
    profile.dontPitch && profile.dontPitchBy
      ? ((await userRef(ctx.tx, profile.dontPitchBy))?.fullName ?? null)
      : null;
  return {
    by,
    at: profile.dontPitch ? (profile.dontPitchAt?.toISOString() ?? null) : null,
    tagged,
  };
}

/** A chat to show the latest of: by its own id when it's known, else the person's latest with the profile. */
export interface ChatRef {
  readonly chatId: string | null;
  readonly profileId: string | null;
}

/**
 * The latest messages of some of the person's own chats, oldest first, to show beside a message waiting for their OK
 * (../sends.ts): each ref's by `chatKey`. A ref with no chat kept has none.
 */
export async function recentOf(
  ctx: Ctx,
  me: string,
  refs: readonly ChatRef[],
): Promise<Map<string, RecentMessage[]>> {
  const chatIds = [...new Set(refs.flatMap((r) => (r.chatId ? [r.chatId] : [])))];
  const profileIds = [...new Set(refs.flatMap((r) => (r.profileId ? [r.profileId] : [])))];
  const out = new Map<string, RecentMessage[]>();
  if (!chatIds.length && !profileIds.length) return out;
  const found = await rows<{
    id: string;
    profile_id: string | null;
    recent: { fromMe: boolean; text: string; at: string }[];
  }>(
    ctx.tx,
    sql`select c.id, c.profile_id, c.recent from addon_outreach.file_chats c
        where c.workspace_id = ${ctx.scope.workspaceId!} and c.user_id = ${me}
          and (${chatIds.length ? sql`c.id in ${chatIds}` : sql`false`}
            or ${profileIds.length ? sql`c.profile_id in ${profileIds}` : sql`false`})
        order by c.last_at desc`,
  );
  const shown = (recent: (typeof found)[number]['recent']): RecentMessage[] =>
    recent.slice(-RECENT_SHOWN).map((m) => ({
      fromMe: m.fromMe,
      text: m.text.slice(0, MESSAGE_MOST),
      at: new Date(m.at).toISOString(),
    }));
  for (const r of refs) {
    const chat =
      (r.chatId ? found.find((c) => c.id === r.chatId) : undefined) ??
      (r.profileId ? found.find((c) => c.profile_id === r.profileId) : undefined);
    out.set(chatKey(r), chat ? shown(chat.recent) : []);
  }
  return out;
}

/** A chat ref's key in `recentOf`'s answer. */
export const chatKey = (r: ChatRef) => `${r.chatId ?? ''}/${r.profileId ?? ''}`;
