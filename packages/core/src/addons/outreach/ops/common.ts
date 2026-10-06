/**
 * What Social Outreach's commands and queries share (server-only): the business they run in, the profiles that tie
 * someone to a social network, where the person's own Facebook stands with them, and who's never pitched. Row
 * security decides what a request sees.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { people, recordTags, tags } from '@hfos/db/schema';
import { fullName, requirePerson, userRef } from '../../../crm/records';
import { personCreate } from '../../../commands/person.create';
import { splitName } from '../../../inbox/contact';
import { userIdOf } from '../../../kernel/actor';
import { HfosError } from '../../../errors';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import { isUniqueViolation } from '../../../kernel/pg-errors';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { addonTimelineLine } from '../../server';
import type { DontPitch } from '../friends';
import { DONT_PITCH_TAG, type FriendState } from '../limits';
import { outreachAddon } from '../manifest';
import { PLATFORMS, type Platform } from '../playbooks';
import type { Friendship } from '../saves';
import { friends, profiles } from '../tables';

export type Ctx = CommandContext | QueryContext;
export type Profile = typeof profiles.$inferSelect;
type ProfileRow = typeof profiles.$inferInsert;

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

/** Whether someone's never pitched, and why: put on the list here, or tagged Friend or family. Null when they may be. */
export async function dontPitchOf(ctx: Ctx, profile: Profile): Promise<DontPitch | null> {
  const tagged =
    profile.personId !== null &&
    (await taggedFriendOrFamily(ctx, [profile.personId])).has(profile.personId);
  if (!profile.dontPitch && !tagged) return null;
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
