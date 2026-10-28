/**
 * What Social Outreach's commands and queries share (server-only): the business they run in, the profiles that tie
 * someone to a social network, where the person's own Facebook stands with them, and who's never pitched. Row
 * security decides what a request sees.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { people, recordTags, tags } from '@hfos/db/schema';
import { personClientCause, personIsClient } from '../../../crm/clients';
import { CLIENT_CAUSES, type ClientCause } from '../../../crm/record-words';
import { fullName, requirePerson, userRef } from '../../../crm/records';
import { personCreate } from '../../../commands/person.create';
import { tagCreate } from '../../../commands/tag.create';
import { splitName } from '../../../inbox/contact';
import { userIdOf } from '../../../kernel/actor';
import { HfosError } from '../../../errors';
import { executeCommandWithin, scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { addonTimelineLine } from '../../server';
import { outreachSettings, type OutreachSettings } from '../chat-read';
import { countryRuleOn, linesCountry, type CountryHow, type CountryRule } from '../countries';
import type { DontPitch, NeverContact } from '../friends';
import { DONT_PITCH_TAG, MESSAGE_MOST, type FriendState } from '../limits';
import type { SendKind } from '../automation';
import { outreachAddon } from '../manifest';
import { profileMisfit } from '../networks';
import type { ClientStanding } from '../person-menu';
import { PARTNER_GOAL, PLATFORMS, type Platform } from '../playbooks';
import type { Friendship } from '../saves';
import { RECENT_SHOWN, type RecentMessage } from '../sends';
import { friends, profiles, sends } from '../tables';
import { matchFileLater } from './file-match';

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
 * The other profiles marked never pitched that stand for the same person, as `twin`: those kept under the same name on
 * the same network, and those on the same customer on any network. Facebook shows one person by number in one place
 * and by username in another, so the same person can be kept twice, and Don't pitch on one covers the other. A stranger
 * who shares the name is left alone too: the safe side. Across networks only the customer counts, never the name
 * (Chris, 2026-10-15). `p` is its alias.
 */
export const neverTwins = (p: string) => sql`select twin.* from addon_outreach.profiles twin
  where twin.workspace_id = ${sql.raw(p)}.workspace_id and twin.id <> ${sql.raw(p)}.id
    and ((twin.platform = ${sql.raw(p)}.platform and ${nameKeyOf('twin')} = ${nameKeyOf(p)})
      or twin.person_id = ${sql.raw(p)}.person_id)
    and ${markedNever('twin')}`;

/**
 * Every profile marked never pitched, as its workspace, network and name, read once for the whole query. A twin looked
 * up profile by profile can't use the name index under row-level security (`lower` and `regexp_replace` aren't
 * leakproof), so each look-up reads every profile: 14 seconds for 1,800, past the API's statement timeout.
 */
const neverNames = sql`select m.workspace_id, m.platform, ${nameKeyOf('m')} from addon_outreach.profiles m
  where m.dont_pitch or m.never_contact or m.person_id in (
    select rt.record_id from app.record_tags rt join app.tags tg on tg.id = rt.tag_id
    where rt.record_type = 'person' and lower(tg.name::text) = lower(${DONT_PITCH_TAG}))`;

/** Whether a profile marked never pitched, itself included, is kept under its name on its network. `p` is its alias. */
const namedNever = (p: string) =>
  sql`(${sql.raw(p)}.workspace_id, ${sql.raw(p)}.platform, ${nameKeyOf(p)}) in (${neverNames})`;

/**
 * Every customer with a profile on Don't pitch or Never contact, on any network, read once for the whole query. Their
 * other profiles are covered too (Chris, 2026-10-15): a customer's Facebook and LinkedIn are one person.
 */
const neverPeople = sql`select m.person_id from addon_outreach.profiles m
  where m.person_id is not null and (m.dont_pitch or m.never_contact)`;

/** Whether a profile's customer has a profile on Don't pitch or Never contact, itself included. `p` is its alias. */
const customerNever = (p: string) =>
  sql`(${sql.raw(p)}.person_id is not null and ${sql.raw(p)}.person_id in (${neverPeople}))`;

/**
 * A profile that may be reached at all as Don't pitch allows: neither it nor a twin of it (`neverTwins`) is marked
 * never pitched, nor on Never contact. Once it isn't marked itself, any profile marked never pitched under its name, or
 * on its customer, is a twin. A partner (`partnered`) is one, and is asked to partner, never pitched. `p` is its alias.
 */
export const notNever = (p: string) =>
  sql`(not ${markedNever(p)} and not ${namedNever(p)} and not ${customerNever(p)})`;

/**
 * Every profile found as a partner (decision 81), as its workspace, network and name, and every customer with one,
 * read once for the whole query (`neverNames`).
 */
const partnerNames = sql`select m.workspace_id, m.platform, ${nameKeyOf('m')} from addon_outreach.profiles m
  where m.partner_found_at is not null`;
const partnerPeople = sql`select m.person_id from addon_outreach.profiles m
  where m.person_id is not null and m.partner_found_at is not null`;

/**
 * Whether a profile, or a twin of it, was found as a partner (decision 81): a profile kept under its name on its
 * network, or another profile on its customer, on any network, as Don't pitch's twins are (`neverTwins`). `p` is its
 * alias.
 */
export const partnered = (p: string) =>
  sql`(${sql.raw(p)}.partner_found_at is not null
    or (${sql.raw(p)}.workspace_id, ${sql.raw(p)}.platform, ${nameKeyOf(p)}) in (${partnerNames})
    or (${sql.raw(p)}.person_id is not null and ${sql.raw(p)}.person_id in (${partnerPeople})))`;

/**
 * A profile that's pitched as a customer: one that may be reached (`notNever`), and neither it nor a twin was found as
 * a partner, who's asked to partner instead (decision 81). `p` is its alias.
 */
export const pitchable = (p: string) => sql`(${notNever(p)} and not ${partnered(p)})`;

/**
 * A playbook that's after customers: any but a partner playbook (decision 81), whose audience is reached through
 * partners. `pb` is its alias.
 */
export const forCustomers = (pb: string) =>
  sql`(${sql.raw(pb)}.details ->> 'goal') is distinct from ${PARTNER_GOAL}`;
/** The same, where `addon_outreach.playbooks` is read with no alias (the worker's reads). */
export const FOR_CUSTOMERS = sql`(details ->> 'goal') is distinct from ${PARTNER_GOAL}`;

/** Every profile on Never contact, as its workspace, network and name, read once for the whole query (`neverNames`). */
const offNames = sql`select m.workspace_id, m.platform, ${nameKeyOf('m')} from addon_outreach.profiles m
  where m.never_contact`;

/** Every customer with a profile on Never contact, on any network, read once for the whole query. */
const offPeople = sql`select m.person_id from addon_outreach.profiles m
  where m.person_id is not null and m.never_contact`;

/**
 * A profile anyone here may contact at all: neither it, nor a profile kept under its name on its network, nor another
 * profile on its customer, is on Never contact. Stronger than `pitchable`, which leaves them out too: this is for what
 * Don't pitch still allows, like a friend request to decide, a reply's push or a message drafted. `p` is its alias.
 */
export const contactable = (p: string) =>
  sql`(not ${sql.raw(p)}.never_contact and (${sql.raw(p)}.workspace_id, ${sql.raw(p)}.platform, ${nameKeyOf(p)}) not in (${offNames})
    and (${sql.raw(p)}.person_id is null or ${sql.raw(p)}.person_id not in (${offPeople})))`;

/**
 * Whether a profile has a twin marked never pitched (`neverTwins`): for one not marked itself, any profile marked
 * under its name or on its customer; for the few marked, looked up. `p` is its alias.
 */
export const hasNeverTwin = (p: string) =>
  sql`(case when ${markedNever(p)} then exists (${neverTwins(p)}) else (${namedNever(p)} or ${customerNever(p)}) end)`;

/**
 * Whether a profile's customer was pitched or booked through another of their profiles, on any network and by anyone
 * here (Chris, 2026-10-15): Today doesn't start them again on this one. Only profiles on the same customer count, never
 * a name. `p` is its alias.
 */
export const reachedElsewhere = (p: string) => sql`(${sql.raw(p)}.person_id is not null and (
  exists (select 1 from addon_outreach.profiles o join addon_outreach.stages s on s.profile_id = o.id
    where o.person_id = ${sql.raw(p)}.person_id and o.id <> ${sql.raw(p)}.id and s.pitched_at is not null)
  or exists (select 1 from addon_outreach.profiles o join addon_outreach.demos d on d.profile_id = o.id
    where o.person_id = ${sql.raw(p)}.person_id and o.id <> ${sql.raw(p)}.id and d.undone_at is null)
  or exists (select 1 from addon_outreach.demos d
    where d.person_id = ${sql.raw(p)}.person_id and d.profile_id <> ${sql.raw(p)}.id and d.undone_at is null)))`;

/**
 * What makes someone a client in Social Outreach (decision 91): core's rule (crm/clients.ts), the Client tag and
 * everything Contacts counts besides (a won lead, a job, a visit, a plan, a paid bill), as the owner chose (Chris,
 * 26 Oct 2026, built with the default asked). To go by the Client tag alone, make this `['tagged']`.
 */
export const OUTREACH_CLIENT_CAUSES: readonly ClientCause[] = CLIENT_CAUSES;

/** Contacts' own reasons among them, besides the tag: what Not a client after all can't take off. */
const OTHER_CAUSES = OUTREACH_CLIENT_CAUSES.filter((c) => c !== 'tagged');

/**
 * Every customer with a profile here who is a client (`OUTREACH_CLIENT_CAUSES`), read once for the whole query, as
 * `neverPeople` is. Never kept: worked out each time.
 */
const clientPeople = sql`select cp.id from app.people cp
  where cp.id in (select m.person_id from addon_outreach.profiles m where m.person_id is not null)
    and ${personIsClient('cp', OUTREACH_CLIENT_CAUSES)}`;

/**
 * The profiles on those customers, as their workspace, network and name, read once for the whole query: someone kept
 * twice under the same name on the same network is a client too, as Don't pitch's twins are (`neverNames`).
 */
const clientNames = sql`select m.workspace_id, m.platform, ${nameKeyOf('m')} from addon_outreach.profiles m
  where m.person_id in (${clientPeople})`;

/**
 * A client (decision 91): the profile's customer is one, on any network, or a profile kept under its name on its
 * network is on one. A client gets no outreach (`inPlay`, `outreach_client`), only replies. `p` is its alias.
 */
export const isClient = (p: string) =>
  sql`((${sql.raw(p)}.person_id is not null and ${sql.raw(p)}.person_id in (${clientPeople}))
    or (${sql.raw(p)}.workspace_id, ${sql.raw(p)}.platform, ${nameKeyOf(p)}) in (${clientNames}))`;

/**
 * A profile open to the person `me` (decision 47): not marked not a fit, by them or by the AI's read of their chat.
 * "Not interested" ends outreach for good, until they put them back in play. Nor is one whose customer was pitched or
 * booked on another of their profiles (`reachedElsewhere`). Confirming a friend request goes by this alone: saying yes
 * is no pitch, so a client's is confirmed too. `p` is its alias.
 */
export const openToMe = (me: string, p: string) => sql`(not exists (
  select 1 from addon_outreach.stages st
  where st.profile_id = ${sql.raw(p)}.id and st.user_id = ${me} and st.mark = 'lost')
  and not ${reachedElsewhere(p)})`;

/**
 * A profile still in play for the person `me`: open to them (`openToMe`), and not a client (`isClient`, decision
 * 91), who gets no outreach. Every pick on Today but a reply they're owed goes by it. `p` is its alias.
 */
export const inPlay = (me: string, p: string) => sql`(${openToMe(me, p)} and not ${isClient(p)})`;

/**
 * The profiles the client rule covers for one customer (`isClient`): every profile on them, on any network, and any
 * kept under the same name as one of those on the same network.
 */
export async function clientProfiles(ctx: CommandContext, personId: string): Promise<string[]> {
  const found = await rows<{ id: string }>(
    ctx.tx,
    sql`select o.id from addon_outreach.profiles o
        where o.workspace_id = ${ctx.scope.workspaceId!}
          and (o.person_id = ${personId}
            or (o.workspace_id, o.platform, ${nameKeyOf('o')}) in (
              select m.workspace_id, m.platform, ${nameKeyOf('m')} from addon_outreach.profiles m
              where m.person_id = ${personId}))`,
  );
  return found.map((f) => f.id);
}

/**
 * Where someone stands as a client (decision 91): one or not, as `isClient` says; their customer tagged Client; and
 * Contacts' own reason besides the tag, first in `CLIENT_CAUSES`' order.
 */
export async function clientOf(ctx: Ctx, profileId: string): Promise<ClientStanding> {
  const [found] = await rows<{ is_client: boolean; tagged: boolean; because: ClientCause | null }>(
    ctx.tx,
    sql`select ${isClient('p')} as is_client,
          (cp.id is not null and ${personIsClient('cp', ['tagged'])}) as tagged,
          ${personClientCause('cp', OTHER_CAUSES)} as because
        from addon_outreach.profiles p
        left join app.people cp on cp.id = p.person_id
        where p.workspace_id = ${ctx.scope.workspaceId!} and p.id = ${profileId}`,
  );
  return {
    on: found?.is_client ?? false,
    tagged: found?.tagged ?? false,
    because: found?.because ?? null,
  };
}

/**
 * Why someone is a client, in a lateral join's column (`because`) for a page of profiles: the first of
 * `OUTREACH_CLIENT_CAUSES` on their customer, the tag included, or null for one kept under a client's name. `p` is the
 * profile's alias.
 */
export const clientCauseOf = (
  p: string,
) => sql`(select ${personClientCause('ccp', OUTREACH_CLIENT_CAUSES)}
  from app.people ccp where ccp.id = ${sql.raw(p)}.person_id)`;

/**
 * Skips the messages waiting for an OK, or OK'd and not sent, to some profiles, anyone's: of `kinds`, or every kind,
 * a comment on their post among them (Never contact). Each skipped tells (`outreach.send.skipped`), so Waiting for you
 * and the phone's copy let it go. How many. A comment skipped here was never the person's skip of the post: its post
 * stays as it was (decision 92's 16 is the person's own Skip).
 */
export async function skipOutreachTo(
  ctx: CommandContext,
  profileIds: readonly string[],
  kinds?: readonly SendKind[],
): Promise<number> {
  if (!profileIds.length || kinds?.length === 0) return 0;
  const at = changeMoment(ctx.meta);
  const skipped = await ctx.tx
    .update(sends)
    .set({ state: 'skipped', doneAt: at, updatedAt: at })
    .where(
      and(
        eq(sends.workspaceId, ctx.scope.workspaceId!),
        inArray(sends.profileId, [...new Set(profileIds)]),
        inArray(sends.state, ['waiting', 'approved']),
        ...(kinds ? [inArray(sends.kind, [...kinds])] : []),
      ),
    )
    .returning({ kind: sends.kind, profileId: sends.profileId });
  for (const s of skipped)
    await ctx.emit({
      type: 'outreach.send.skipped',
      entityType: 'outreach_profile',
      entityId: s.profileId,
      payload: { kind: s.kind },
    });
  return skipped.length;
}

/** The business's tags by these names, any capitals, made where they're missing (`tag.create`). Their ids. */
export async function tagIdsFor(ctx: CommandContext, names: readonly string[]): Promise<string[]> {
  if (!names.length) return [];
  const ws = ctx.scope.workspaceId!;
  const had = await ctx.tx
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(
      and(
        eq(tags.workspaceId, ws),
        // The name is citext, whose own = isn't on the search path here: compared without capitals instead.
        sql`lower(${tags.name}::text) in (${sql.join(
          names.map((n) => sql`${n.toLowerCase()}`),
          sql`, `,
        )})`,
      ),
    );
  const byKey = new Map(had.map((t) => [String(t.name).toLowerCase(), t.id]));
  const ids: string[] = [];
  for (const name of names) {
    const id =
      byKey.get(name.toLowerCase()) ??
      (await executeCommandWithin(ctx, tagCreate, { workspaceId: ws, name })).output.tagId;
    byKey.set(name.toLowerCase(), id);
    ids.push(id);
  }
  return [...new Set(ids)];
}

/** The business's Social Outreach settings, as they're read: the defaults where they aren't set. */
export async function outreachSettingsOf(ctx: Ctx): Promise<OutreachSettings> {
  const [installed] = await rows<{ settings: unknown }>(
    ctx.tx,
    sql`select settings from app.addon_installations
        where workspace_id = ${ctx.scope.workspaceId!} and addon_id = ${outreachAddon.id}`,
  );
  return outreachSettings(installed?.settings);
}

/** The business's country setting (decision 61), as it's read: Anywhere when it isn't set. */
export async function countryRuleOf(ctx: Ctx): Promise<CountryRule> {
  return (await outreachSettingsOf(ctx)).countries;
}

/**
 * What the business's country setting does with a profile (decisions 61 and 86): `reach`, `look` (waiting for a look
 * first), `ask` (the Not sure list) or `skip`. The SQL copy of `countryFate` in ../countries.ts, the one copy of the
 * rule; `p` is the profile's alias.
 */
export function countryFateSql(rule: CountryRule, p: string) {
  if (!countryRuleOn(rule)) return sql`'reach'`;
  const a = sql.raw(p);
  const codes = `{${rule.codes.join(',')}}`;
  const listed = (col: string) => sql`(${a}.${sql.raw(col)} = any (${codes}::text[]))`;
  const lets = rule.mode === 'only' ? listed('country') : sql`not ${listed('country')}`;
  // Words from the rule's own fixed list, never what a request sent.
  const unsure = sql.raw(`'${rule.unsure === 'through' ? 'reach' : rule.unsure}'`);
  const unknown = sql.raw(`'${rule.unsure === 'through' ? 'reach' : 'look'}'`);
  return sql`(case
    when ${a}.country_through then 'reach'
    when ${a}.country_skip then 'skip'
    when ${a}.country_looked_at is not null or ${a}.country_how = 'seen' then
      case
        when ${a}.country_unsure or ${a}.country is null
          or (${a}.country_alt is not null and ${listed('country_alt')} <> ${listed('country')})
          then ${unsure}
        when ${lets} then 'reach'
        else 'skip'
      end
    when ${a}.country is not null then case when ${lets} then 'reach' else 'look' end
    else ${unknown}
  end)`;
}

/** Someone who runs one of the groups they were found in: left alone, never reached. `p` is the profile's alias. */
export const runsAGroup = (p: string) =>
  sql`exists (select 1 from addon_outreach.group_people x where x.profile_id = ${sql.raw(p)}.id and x.runs_group)`;

/**
 * Waiting for a look at where they live (decision 86): what the country setting says of them, and someone Today could
 * reach, so not anyone who runs a group. `p` is the profile's alias.
 */
export const waitsForLook = (rule: CountryRule, p: string) =>
  countryRuleOn(rule)
    ? sql`(${countryFateSql(rule, p)} = 'look' and not ${runsAGroup(p)})`
    : sql`false`;

/**
 * Keeps where someone lives from what's read without a look (decision 86): the lines under their name or the AI's
 * guess. The strongest wins: a look's answer stands, and a "Lives in" beats a From, which beats a guess. Whether it
 * was kept.
 */
export async function keepCountry(
  ctx: CommandContext,
  profileId: string,
  found: { readonly country: string | null; readonly how: Exclude<CountryHow, 'friends'> },
): Promise<boolean> {
  const how: CountryHow = found.country
    ? found.how === 'unknown'
      ? 'guessed'
      : found.how
    : 'unknown';
  const weaker: CountryHow[] =
    how === 'seen'
      ? ['from', 'guessed', 'unknown']
      : how === 'from'
        ? ['guessed', 'unknown']
        : ['unknown'];
  const done = await ctx.tx
    .update(profiles)
    .set({
      country: found.country,
      countryHow: how,
      countryAt: changeMoment(ctx.meta),
      ...(how === 'from' ? { countryFrom: found.country } : {}),
    })
    .where(
      and(
        eq(profiles.workspaceId, ctx.scope.workspaceId!),
        eq(profiles.id, profileId),
        isNull(profiles.countryLookedAt),
        or(isNull(profiles.countryHow), inArray(profiles.countryHow, weaker)),
      ),
    )
    .returning({ id: profiles.id });
  return done.length > 0;
}

/**
 * A profile the business's country setting lets be reached now (decisions 61 and 86): let through with Unskip, or
 * where it lives in (or not in) the countries picked; never while it waits for a look or a person's call. `p` is its
 * alias.
 */
export function countryLetsSql(rule: CountryRule, p: string) {
  if (!countryRuleOn(rule)) return sql`true`;
  return sql`(${countryFateSql(rule, p)} = 'reach')`;
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
 * Refuses a profile that isn't on the network it was sent for (`profileMisfit`): its link on another network's pages,
 * or an id or name of another network's shape. Every save that keeps a profile asks first.
 */
export function requireFits(
  platform: Platform,
  profile: ProfileKey & { readonly url: string },
): void {
  const misfit = profileMisfit(platform, profile);
  if (misfit) throw HfosError.rule('outreach_wrong_network', 400, misfit);
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
  requireFits(input.platform, input.profile);
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
    // Saved after the person's file came in: the file's word on them now, not at the next file.
    if (me) await matchFileLater(ctx, me, input.platform, [{ name: input.name }]);
  }

  // A "Lives in" or a "From" among their lines says where they live (decision 86).
  const lined = input.facts ? linesCountry(input.facts.intro) : null;
  if (lined) await keepCountry(ctx, profileId, lined);

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
  requireFits(input.platform, input.profile);
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
    await matchFileLater(ctx, me, input.platform, [row!]);
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
  /** When it began, when the list said (LinkedIn's file): else it begins now. */
  readonly since?: Date | null;
}

/**
 * Where the person's own Facebook stands with some profiles, as seen or noted at `at`. A new state starts its
 * `since` (then, or when the list said it began), and the same one seen again only moves `seen_at`, and `since` back
 * to an earlier beginning the list said. A later look stays when what's sent is older (a step
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
  for (const { profileId, state: seenState, since: said } of seen) {
    const was = had.get(profileId);
    if (was && was.seenAt > at) continue;
    const state = was?.state === 'declined' && seenState === 'not_friends' ? 'declined' : seenState;
    if (was?.state !== state) changed.add(profileId);
    // A beginning the list said, never later than now; for a state that stays, only one earlier than kept.
    const began = said && said < at ? said : null;
    const since =
      was?.state === state ? (began && began < was.since ? began : was.since) : (began ?? at);
    write.set(profileId, { state, since, seenAt: at });
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
 * their twin, kept under the same name or on the same customer (`neverTwins`). Null when they may be.
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

/**
 * Whether someone's on the business's Never contact list, or their twin is (kept under the same name on the same
 * network, or on the same customer on any network): who put them on it and when. Null when they aren't.
 */
export async function neverContactOf(ctx: Ctx, profile: Profile): Promise<NeverContact | null> {
  const [on] = await rows<{ by: string | null; at: Date | string | null }>(
    ctx.tx,
    sql`select coalesce(nullif(u.full_name, ''), u.email::text) as by, m.never_contact_at as at
        from addon_outreach.profiles p
        join addon_outreach.profiles m on m.workspace_id = p.workspace_id and m.never_contact
          and (m.id = p.id or m.person_id = p.person_id
            or (m.platform = p.platform and ${nameKeyOf('m')} = ${nameKeyOf('p')}))
        left join app.users u on u.id = m.never_contact_by
        where p.id = ${profile.id}
        order by (m.id = p.id) desc limit 1`,
  );
  return on ? { by: on.by, at: on.at === null ? null : new Date(on.at).toISOString() } : null;
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
