/**
 * What Social Outreach's commands and queries share (server-only): the business they run in, and the profiles that
 * tie a customer to a social network. Row security decides what a request sees.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { people } from '@hfos/db/schema';
import { fullName, requirePerson } from '../../../crm/records';
import { personCreate } from '../../../commands/person.create';
import { splitName } from '../../../inbox/contact';
import { userIdOf } from '../../../kernel/actor';
import { executeCommandWithin } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { addonTimelineLine } from '../../server';
import { outreachAddon } from '../manifest';
import { PLATFORMS, type Platform } from '../playbooks';
import type { Friendship } from '../saves';
import { profiles } from '../tables';

export type Ctx = CommandContext | QueryContext;
export type Profile = typeof profiles.$inferSelect;

export const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

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
