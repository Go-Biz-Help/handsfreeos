/**
 * Friends (docs/outreach.md, decisions 10 to 13): the person answering a friend request on Facebook, their friends
 * list and the requests they've got saved from the page, Keep and Don't pitch, and the Friends tab. None of it adds
 * anyone to Contacts: someone new is kept as a profile with no customer, like someone a step was noted to.
 */
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { DownloadCounts } from '../download';
import { bestFit, byFit, type FitPlaybook } from '../fit';
import {
  DONT_PITCH_TAG,
  FRIENDS_CAP,
  FRIENDS_PAGE,
  FriendNoteInput,
  FriendNoteOutput,
  FriendSetInput,
  FriendSetOutput,
  FriendsInput,
  FriendsOutput,
  FriendsSaveInput,
  FriendsSaveOutput,
  type FriendList,
  type FriendState,
  type FriendView,
} from '../friends';
import { outreachAddon } from '../manifest';
import { PlaybookDetails, upgradePlaybookDetails, type Platform } from '../playbooks';
import type { Friendship } from '../saves';
import { friends, imports, playbooks, profiles } from '../tables';
import {
  dontPitchOf,
  inWorkspace,
  keepFriendStates,
  keptProfile,
  once,
  type Profile,
  type ProfileKey,
} from './common';
import { clearNeeds } from './needs';

/** What a list says about everyone in it: where the person's own Facebook stands with them, and so their profile. */
const LIST_STATE: Readonly<Record<FriendList, FriendState & Friendship>> = {
  friends: 'friends',
  requests: 'request_received',
  sent: 'request_sent',
};

export const friendNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.friend.note',
  description:
    'Note the person answering a friend request on a social network themselves, as the extension saw it: Confirm makes them friends, and Delete turns the request down. Adds nobody to Contacts.',
  risk: 1,
  input: FriendNoteInput,
  output: FriendNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Answered already on Facebook: noted whenever it arrives.
  offline: 'anytime',
  emits: ['outreach.friend.answered'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const state: FriendState = input.answer === 'confirm' ? 'friends' : 'declined';
    return once(async () => {
      const profile = await keptProfile(
        ctx,
        input,
        me,
        at,
        {
          friendship: state === 'friends' ? 'friends' : 'not_friends',
          mutualFriends: input.mutualFriends,
        },
        (had) => ({
          ...(at >= had.lastSeenAt
            ? {
                friendship: state === 'friends' ? ('friends' as const) : ('not_friends' as const),
                lastSeenBy: me,
                lastSeenAt: at,
              }
            : {}),
          ...(input.mutualFriends !== null ? { mutualFriends: input.mutualFriends } : {}),
        }),
      );
      await keepFriendStates(ctx, me, [{ profileId: profile.id, state }], at);
      // Confirm or Delete pressed: a request the extension handed to the person is answered.
      await clearNeeds(ctx, me, { profileId: profile.id, steps: ['confirm'] }, at);
      await ctx.emit({
        type: 'outreach.friend.answered',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: {
          platform: input.platform,
          answer: input.answer,
          personId: profile.personId,
        },
      });
      return { profileId: profile.id, personId: profile.personId, state };
    });
  },
});

/** A list's people, each once, by their profile's number or else its username. */
function eachOnce<T extends { readonly profile: ProfileKey }>(people: readonly T[]): T[] {
  const seen = new Set<string>();
  return people.filter((p) => {
    const key = p.profile.id ? `id:${p.profile.id}` : `user:${p.profile.username!.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const friendsSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.friends.save',
  description:
    'Save a list the extension read off a social network, as far as the page had loaded: the person’s friends, the friend requests they’ve got, or the ones they’ve sent. Adds nobody to Contacts.',
  risk: 1,
  input: FriendsSaveInput,
  output: FriendsSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.friends.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const people = eachOnce(input.people);
    return once(async () => {
      const ids = people.flatMap((p) => (p.profile.id ? [p.profile.id] : []));
      const usernames = people.flatMap((p) =>
        p.profile.username ? [p.profile.username.toLowerCase()] : [],
      );
      const kept = await ctx.tx
        .select()
        .from(profiles)
        .where(
          and(
            eq(profiles.workspaceId, ws),
            eq(profiles.platform, input.platform),
            or(
              ids.length ? inArray(profiles.platformId, ids) : sql`false`,
              usernames.length ? inArray(sql`lower(${profiles.username})`, usernames) : sql`false`,
            ),
          ),
        );
      const byId = new Map(kept.flatMap((p) => (p.platformId ? [[p.platformId, p]] : [])));
      const byUsername = new Map(
        kept.flatMap((p) => (p.username ? [[p.username.toLowerCase(), p]] : [])),
      );
      const found = (key: ProfileKey): Profile | undefined =>
        (key.id ? byId.get(key.id) : undefined) ??
        (key.username ? byUsername.get(key.username.toLowerCase()) : undefined);

      // New to HandsFreeOS: kept as profiles with no customer.
      const fresh = people.filter((p) => !found(p.profile));
      const added = fresh.length
        ? await ctx.tx
            .insert(profiles)
            .values(
              fresh.map((p) => ({
                workspaceId: ws,
                personId: null,
                platform: input.platform,
                platformId: p.profile.id,
                username: p.profile.username,
                url: p.profile.url,
                name: p.name,
                friendship: LIST_STATE[input.list],
                mutualFriends: p.mutualFriends,
                savedBy: me,
                lastSeenBy: me,
                lastSeenAt: at,
              })),
            )
            .returning()
        : [];
      for (const p of added) {
        if (p.platformId) byId.set(p.platformId, p);
        if (p.username) byUsername.set(p.username.toLowerCase(), p);
      }

      // Known already: what the list says now, and a number or username the first look didn't show.
      const friendship = LIST_STATE[input.list];
      for (const p of people) {
        const had = found(p.profile)!;
        if (added.includes(had)) continue;
        // Another kept profile has the number or username already: two looks the two can't be matched by.
        const taken = (one: Profile | undefined) => one !== undefined && one !== had;
        const other =
          (p.profile.id !== null && taken(byId.get(p.profile.id))) ||
          (p.profile.username !== null && taken(byUsername.get(p.profile.username.toLowerCase())));
        const change = {
          ...(!had.platformId && p.profile.id && !other ? { platformId: p.profile.id } : {}),
          ...(!had.username && p.profile.username && !other
            ? { username: p.profile.username }
            : {}),
          ...(at >= had.lastSeenAt && had.friendship !== friendship
            ? { friendship, lastSeenBy: me, lastSeenAt: at }
            : {}),
          ...(p.mutualFriends !== null && p.mutualFriends !== had.mutualFriends
            ? { mutualFriends: p.mutualFriends }
            : {}),
        };
        if (Object.keys(change).length)
          await ctx.tx.update(profiles).set(change).where(eq(profiles.id, had.id));
      }

      const changed = await keepFriendStates(
        ctx,
        me,
        people.map((p) => ({ profileId: found(p.profile)!.id, state: LIST_STATE[input.list] })),
        at,
      );
      const result = {
        saved: people.length,
        added: added.length,
        changed: changed.size - added.length,
      };
      await ctx.emit({
        type: 'outreach.friends.saved',
        entityType: 'workspace',
        entityId: ws,
        payload: { platform: input.platform, list: input.list, ...result },
      });
      return result;
    });
  },
});

/** The profile `friend.set` and `demo.mark` are about: the one kept here, or the one on the page, kept now when it's new. */
export async function profileToSet(
  ctx: CommandContext,
  input: Pick<FriendSetInput, 'profileId' | 'profile' | 'name'> & { readonly platform: Platform },
  me: string,
  at: Date,
): Promise<Profile> {
  if (input.profileId) {
    const [had] = await ctx.tx
      .select()
      .from(profiles)
      .where(
        and(eq(profiles.workspaceId, ctx.scope.workspaceId!), eq(profiles.id, input.profileId)),
      );
    if (!had)
      throw HfosError.notFound(
        'That person isn’t in Social Outreach anymore. Refresh the page and try again.',
      );
    return had;
  }
  return keptProfile(
    ctx,
    { platform: input.platform, profile: input.profile!, name: input.name! },
    me,
    at,
  );
}

export const friendSet = defineAddonCommand(outreachAddon, {
  name: 'outreach.friend.set',
  description:
    'Keep a friend (never suggested for unfriending), or put someone on the business’s Don’t pitch list (never a friend request, like, comment or message) or take them off it.',
  risk: 1,
  input: FriendSetInput,
  output: FriendSetOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.friend.marked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      let profile = await profileToSet(ctx, input, me, at);
      if (input.dontPitch !== undefined && input.dontPitch !== profile.dontPitch) {
        // Taking someone off is for whoever put them on, or an owner or admin: it can't undo a teammate's family.
        if (
          !input.dontPitch &&
          profile.dontPitchBy &&
          profile.dontPitchBy !== me &&
          !scopeCan(ctx.scope, 'outreach.manage' as Permission)
        ) {
          const was = await dontPitchOf(ctx, profile);
          throw HfosError.forbidden(
            `${was?.by ?? 'A teammate'} put ${profile.name} on the Don’t pitch list, so only they or an owner or admin can take them off.`,
            'outreach_dont_pitch_not_yours',
          );
        }
        [profile] = (await ctx.tx
          .update(profiles)
          .set(
            input.dontPitch
              ? { dontPitch: true, dontPitchBy: me, dontPitchAt: at }
              : { dontPitch: false, dontPitchBy: null, dontPitchAt: null },
          )
          .where(eq(profiles.id, profile.id))
          .returning()) as [Profile];
      }
      const [friend] = await ctx.tx
        .select()
        .from(friends)
        .where(
          and(
            eq(friends.workspaceId, ws),
            eq(friends.userId, me),
            eq(friends.profileId, profile.id),
          ),
        );
      let keep = friend?.keep ?? false;
      if (input.keep !== undefined && input.keep !== keep) {
        keep = input.keep;
        if (friend) await ctx.tx.update(friends).set({ keep }).where(eq(friends.id, friend.id));
        // Keeping someone with no state kept is keeping a friend.
        else
          await ctx.tx.insert(friends).values({
            workspaceId: ws,
            userId: me,
            profileId: profile.id,
            state: 'friends',
            since: at,
            seenAt: at,
            keep,
          });
      }
      const dontPitch = await dontPitchOf(ctx, profile);
      await ctx.emit({
        type: 'outreach.friend.marked',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: { platform: profile.platform, keep, dontPitch: dontPitch !== null },
      });
      return { profileId: profile.id, keep, dontPitch };
    });
  },
});

type Listed = {
  readonly profile_id: string;
  readonly person_id: string | null;
  readonly name: string;
  readonly url: string;
  readonly state: FriendState | null;
  readonly since: Date | string | null;
  readonly keep: boolean | null;
  readonly dont_pitch: boolean;
  readonly dont_pitch_by: string | null;
  readonly dont_pitch_at: Date | string | null;
  readonly tagged: boolean;
  readonly mutual_friends: number | null;
  readonly intro: string[];
  readonly group_name: string | null;
  readonly group_url: string | null;
};

/** Who each view shows, from a profile's row below. */
const VIEW_WHERE: Readonly<Record<FriendView, ReturnType<typeof sql>>> = {
  friends: sql`l.state = 'friends'`,
  requests: sql`l.state = 'request_received'`,
  sent: sql`l.state = 'request_sent'`,
  keep: sql`l.keep`,
  dont_pitch: sql`(l.dont_pitch or l.tagged)`,
};

/** Each view's order: by name, the newest request first (before fit), the oldest sent first, the latest marked first. */
const VIEW_ORDER: Readonly<Record<FriendView, ReturnType<typeof sql>>> = {
  friends: sql`lower(l.name), l.profile_id`,
  requests: sql`l.since desc, l.profile_id`,
  sent: sql`l.since, l.profile_id`,
  keep: sql`lower(l.name), l.profile_id`,
  dont_pitch: sql`l.dont_pitch_at desc nulls last, lower(l.name), l.profile_id`,
};

/** The most requests put in order of fit at once: more than Facebook lets anyone keep waiting. */
const REQUESTS_MOST = 1000;

/** The business's playbooks in use, as much as fit reads. One that doesn't read is left out. */
export async function playbooksInUse(
  ctx: QueryContext | CommandContext,
): Promise<(FitPlaybook & { readonly details: PlaybookDetails })[]> {
  const list = await ctx.tx
    .select({ id: playbooks.id, name: playbooks.name, details: playbooks.details })
    .from(playbooks)
    .where(and(eq(playbooks.workspaceId, ctx.scope.workspaceId!), isNull(playbooks.archivedAt)));
  return list.flatMap((p) => {
    const read = PlaybookDetails.safeParse(upgradePlaybookDetails(p.details));
    return read.success ? [{ id: p.id, name: p.name, details: read.data }] : [];
  });
}

const isoOrNull = (at: Date | string | null) => (at === null ? null : new Date(at).toISOString());

/** What the person's download file says about some profiles: since when friends, and the latest message either way. */
async function fileFacts(
  ctx: QueryContext,
  me: string,
  profileIds: readonly string[],
): Promise<
  Map<string, { friendsSince: string | null; lastMessage: { at: string; fromMe: boolean } | null }>
> {
  if (!profileIds.length) return new Map();
  const found = await rows<{
    profile_id: string;
    friends_since: Date | string | null;
    last_at: Date | string | null;
    last_from_me: boolean | null;
  }>(
    ctx.tx,
    sql`select p.id as profile_id,
          (select max(fp.at) from addon_outreach.file_people fp
            where fp.profile_id = p.id and fp.user_id = ${me} and fp.list = 'friends') as friends_since,
          m.at as last_at, m.from_me as last_from_me
        from addon_outreach.profiles p
        left join lateral (
          select x.at, x.from_me from (
            select fc.last_at as at, fc.last_from_me as from_me from addon_outreach.file_chats fc
              where fc.profile_id = p.id and fc.user_id = ${me}
            union all
            select t.at, true from addon_outreach.touches t
              where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'message'
          ) x order by x.at desc, x.from_me limit 1
        ) m on true
        where p.workspace_id = ${ctx.scope.workspaceId!}
          and p.id = any (${`{${profileIds.join(',')}}`}::uuid[])`,
  );
  return new Map(
    found.map((f) => [
      f.profile_id,
      {
        friendsSince: isoOrNull(f.friends_since),
        lastMessage:
          f.last_at === null
            ? null
            : { at: isoOrNull(f.last_at)!, fromMe: f.last_from_me ?? false },
      },
    ]),
  );
}

/** The person's latest download file brought in, for the Friends tab. */
async function latestDownload(ctx: QueryContext, me: string) {
  const [latest] = await ctx.tx
    .select({ madeAt: imports.madeAt, at: imports.finishedAt, counts: imports.counts })
    .from(imports)
    .where(
      and(
        eq(imports.workspaceId, ctx.scope.workspaceId!),
        eq(imports.userId, me),
        isNotNull(imports.finishedAt),
      ),
    )
    .orderBy(desc(imports.finishedAt))
    .limit(1);
  const counts = DownloadCounts.safeParse(latest?.counts);
  return latest?.at && counts.success
    ? { madeAt: latest.madeAt.toISOString(), at: latest.at.toISOString(), counts: counts.data }
    : null;
}

export const friendsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.friends',
  description:
    'The person’s own friends on a social network as the extension saved them, the friend requests they’ve got (the best fit to the playbooks first) and sent, the friends they keep, and the business’s Don’t pitch list.',
  input: FriendsInput,
  output: FriendsOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const tagged = sql`exists (select 1 from app.record_tags rt join app.tags t on t.id = rt.tag_id
      where rt.workspace_id = p.workspace_id and rt.record_type = 'person' and rt.record_id = p.person_id
        and lower(t.name::text) = lower(${DONT_PITCH_TAG}))`;

    const [mine] = await rows<{ friends: number; requests: number; sent: number; keep: number }>(
      ctx.tx,
      sql`select count(*) filter (where state = 'friends')::int as friends,
            count(*) filter (where state = 'request_received')::int as requests,
            count(*) filter (where state = 'request_sent')::int as sent,
            count(*) filter (where keep)::int as keep
          from addon_outreach.friends where workspace_id = ${ws} and user_id = ${me}`,
    );
    const [never] = await rows<{ dont_pitch: number }>(
      ctx.tx,
      sql`select count(*)::int as dont_pitch from addon_outreach.profiles p
          where p.workspace_id = ${ws} and (p.dont_pitch or ${tagged})`,
    );

    const profilesHere = sql`select p.id as profile_id, p.person_id,
        coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name, p.url,
        f.state, f.since, f.keep, p.dont_pitch,
        coalesce(nullif(u.full_name, ''), u.email::text) as dont_pitch_by, p.dont_pitch_at,
        ${tagged} as tagged, p.mutual_friends, p.intro, g.name as group_name, g.url as group_url
      from addon_outreach.profiles p
      left join addon_outreach.friends f on f.profile_id = p.id and f.user_id = ${me}
      left join app.people pp on pp.id = p.person_id
      left join app.users u on u.id = p.dont_pitch_by
      left join addon_outreach.groups g on g.id = p.group_id
      where p.workspace_id = ${ws}`;
    const shown = sql`${VIEW_WHERE[input.view]}
      and ${input.search ? sql`position(${input.search.toLowerCase()} in lower(l.name)) > 0` : sql`true`}`;
    const read = (limit: number, offset = 0) =>
      rows<Listed>(
        ctx.tx,
        sql`select l.* from (${profilesHere}) l where ${shown}
            order by ${VIEW_ORDER[input.view]} limit ${limit} offset ${offset}`,
      );
    const counted = async () => {
      const [got] = await rows<{ total: number }>(
        ctx.tx,
        sql`select count(*)::int as total from (${profilesHere}) l where ${shown}`,
      );
      return got?.total ?? 0;
    };

    const requests = input.view === 'requests';
    const fitted = requests ? await playbooksInUse(ctx) : null;
    const personOf = (l: Listed) => {
      const fit = fitted
        ? bestFit(fitted, {
            lines: l.intro,
            mutualFriends: l.mutual_friends,
            groupName: l.group_name,
          })
        : null;
      return {
        profileId: l.profile_id,
        personId: l.person_id,
        name: l.name,
        url: l.url,
        state: l.state,
        since: isoOrNull(l.since),
        keep: l.keep ?? false,
        dontPitch:
          l.dont_pitch || l.tagged
            ? {
                by: l.dont_pitch ? l.dont_pitch_by : null,
                at: l.dont_pitch ? isoOrNull(l.dont_pitch_at) : null,
                tagged: l.tagged,
              }
            : null,
        mutualFriends: l.mutual_friends,
        intro: l.intro.slice(0, 3),
        group: l.group_url ? { name: l.group_name, url: l.group_url } : null,
        fit: fit && {
          level: fit.level,
          score: fit.score,
          playbookName: fit.playbookName,
          reasons: [...fit.reasons],
        },
      };
    };

    // The friend requests go in order of fit, worked out here, so they're all read and the page is cut from that
    // order. Any other view is counted, and its page read, in the database.
    const allRequests = requests ? byFit((await read(REQUESTS_MOST)).map(personOf)) : null;
    const total = allRequests ? allRequests.length : await counted();
    const pages = Math.max(1, Math.ceil(total / FRIENDS_PAGE));
    const page = Math.min(input.page, pages);
    const from = (page - 1) * FRIENDS_PAGE;
    const shownPeople = allRequests
      ? allRequests.slice(from, from + FRIENDS_PAGE)
      : (await read(FRIENDS_PAGE, from)).map(personOf);
    const facts = await fileFacts(
      ctx,
      me,
      shownPeople.map((p) => p.profileId),
    );
    const people = shownPeople.map((p) => ({
      ...p,
      friendsSince: facts.get(p.profileId)?.friendsSince ?? null,
      lastMessage: facts.get(p.profileId)?.lastMessage ?? null,
    }));
    return {
      counts: {
        friends: mine?.friends ?? 0,
        requests: mine?.requests ?? 0,
        sent: mine?.sent ?? 0,
        keep: mine?.keep ?? 0,
        dontPitch: never?.dont_pitch ?? 0,
      },
      cap: FRIENDS_CAP,
      download: await latestDownload(ctx, me),
      people,
      page,
      pages,
      total,
      more: Math.max(0, total - from - people.length),
    };
  },
});

export const friendCommands = [friendNote, friendsSave, friendSet] as const;
export const friendQueries = [friendsList] as const;
