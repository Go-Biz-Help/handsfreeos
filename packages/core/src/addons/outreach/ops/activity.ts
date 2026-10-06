/**
 * What the browser extension notes as the person works on Facebook, and the activity panel drawn from it
 * (docs/outreach.md, decisions 7 and 8): each friend request, like, comment and message they send there themselves,
 * to whom and from which group; and how many of each in a stretch of days. Noting a step never adds anyone to
 * Contacts: someone reached is kept as a profile without a customer until the person saves them.
 */
import { and, between, desc, eq, lte, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { addDays, localDateOf, startOfLocalDay } from '../../../calendar/engine/zoned';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { scopeCan } from '../../../kernel/execute';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext } from '../../../kernel/types';
import type { Permission } from '../../../permissions';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  ACTIVITY_GROUPS,
  ACTIVITY_PEOPLE,
  ACTIVITY_PERIODS,
  ActivityInput,
  ActivityOutput,
  TouchSaveInput,
  TouchSaveOutput,
  type GroupRef,
  type TouchKind,
  type TouchStep,
} from '../activity';
import { outreachAddon } from '../manifest';
import type { Platform } from '../playbooks';
import { groups, profiles, threads, touches } from '../tables';
import { inWorkspace, once, profilesFor, type Profile, type ProfileKey } from './common';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The group a step came from, kept the first time it's seen: by its number or the name in its link, whichever the
 * link showed, and a later look fills in the other (unless another kept group has it) and its latest name.
 */
async function keepGroup(
  ctx: CommandContext,
  platform: Platform,
  group: GroupRef,
): Promise<string> {
  const ws = ctx.scope.workspaceId!;
  const by = [
    ...(group.id ? [eq(groups.platformId, group.id)] : []),
    ...(group.slug ? [sql`lower(${groups.slug}) = lower(${group.slug})`] : []),
  ];
  const found = await ctx.tx
    .select()
    .from(groups)
    .where(and(eq(groups.workspaceId, ws), eq(groups.platform, platform), or(...by)));
  // By number first: a link's name can be changed, and its number can't.
  found.sort((a, b) => Number(b.platformId === group.id) - Number(a.platformId === group.id));
  const had = found[0];
  if (!had) {
    const [row] = await ctx.tx
      .insert(groups)
      .values({
        workspaceId: ws,
        platform,
        platformId: group.id,
        slug: group.slug,
        url: group.url,
        name: group.name,
      })
      .returning({ id: groups.id });
    return row!.id;
  }
  const only = found.length === 1;
  const change = {
    ...(!had.platformId && group.id && only ? { platformId: group.id } : {}),
    ...(!had.slug && group.slug && only ? { slug: group.slug } : {}),
    ...(group.name && group.name !== had.name ? { name: group.name } : {}),
  };
  if (Object.keys(change).length)
    await ctx.tx.update(groups).set(change).where(eq(groups.id, had.id));
  return had.id;
}

/**
 * The profile a step was to: the one kept already, or a new one with no customer. A later look fills in its number
 * or username (unless another kept profile has it) and the group it was first found in; a friend request says so
 * where the profile said they weren't friends or didn't know. Its name and the rest stay as the last save wrote them.
 */
async function reachedProfile(
  ctx: CommandContext,
  input: {
    readonly platform: Platform;
    readonly profile: ProfileKey & { readonly url: string };
    readonly name: string;
    readonly kind: TouchKind;
    readonly groupId: string | null;
  },
  me: string,
  at: Date,
): Promise<Profile> {
  const found = await profilesFor(ctx, input.platform, input.profile);
  const had = found[0];
  const requested = input.kind === 'friend_request';
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
        friendship: requested ? 'request_sent' : 'unknown',
        groupId: input.groupId,
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
    ...(!had.groupId && input.groupId ? { groupId: input.groupId } : {}),
    ...(requested && (had.friendship === 'not_friends' || had.friendship === 'unknown')
      ? { friendship: 'request_sent' as const, lastSeenBy: me, lastSeenAt: at }
      : {}),
  };
  if (!Object.keys(change).length) return had;
  const [row] = await ctx.tx
    .update(profiles)
    .set(change)
    .where(eq(profiles.id, had.id))
    .returning();
  return row!;
}

/**
 * The same step noted already, which isn't counted twice: the same post liked again, or another friend request to
 * them within a day (sent, cancelled and sent again). Comments and messages each count.
 */
async function notedAlready(
  ctx: CommandContext,
  me: string,
  profileId: string,
  input: { readonly kind: TouchKind; readonly postUrl: string | null },
  at: Date,
): Promise<string | null> {
  const same =
    input.kind === 'like' && input.postUrl
      ? eq(touches.postUrl, input.postUrl)
      : input.kind === 'friend_request'
        ? between(touches.at, new Date(at.getTime() - DAY), new Date(at.getTime() + DAY))
        : null;
  if (!same) return null;
  const [had] = await ctx.tx
    .select({ id: touches.id })
    .from(touches)
    .where(
      and(
        eq(touches.profileId, profileId),
        eq(touches.userId, me),
        eq(touches.kind, input.kind),
        same,
      ),
    )
    .limit(1);
  return had?.id ?? null;
}

/**
 * A message's place in the outreach (TOUCH_STEPS): neither when it answers them; the first message to them, unless
 * a chat with them was saved already (then it's writing to them again); and after that, the first on each later day,
 * in the business's time zone.
 */
async function messageStep(
  ctx: CommandContext,
  me: string,
  profile: Profile,
  input: {
    readonly platform: Platform;
    readonly threadKey: string | null;
    readonly replying: boolean | null;
  },
  at: Date,
): Promise<TouchStep | null> {
  if (input.replying) return null;
  const [before] = await ctx.tx
    .select({ at: touches.at })
    .from(touches)
    .where(
      and(
        eq(touches.profileId, profile.id),
        eq(touches.userId, me),
        eq(touches.kind, 'message'),
        lte(touches.at, at),
      ),
    )
    .orderBy(desc(touches.at))
    .limit(1);
  if (before) {
    const timezone = await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!);
    return localDateOf(before.at.getTime(), timezone) < localDateOf(at.getTime(), timezone)
      ? 'follow_up'
      : null;
  }
  const chat = [
    ...(input.threadKey ? [eq(threads.threadKey, input.threadKey)] : []),
    ...(profile.personId ? [eq(threads.personId, profile.personId)] : []),
  ];
  const [saved] = chat.length
    ? await ctx.tx
        .select({ id: threads.id })
        .from(threads)
        .where(
          and(
            eq(threads.workspaceId, ctx.scope.workspaceId!),
            eq(threads.platform, input.platform),
            eq(threads.ownerUserId, me),
            or(...chat),
          ),
        )
        .limit(1)
    : [];
  return saved ? 'follow_up' : 'first_message';
}

export const touchSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.touch.save',
  description:
    'Note a step the person took on a social network themselves, as the extension saw it: a friend request, a like, a comment or a message, to whom and from which group. Adds nobody to Contacts.',
  risk: 1,
  input: TouchSaveInput,
  output: TouchSaveOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // Taken already on Facebook: noted whenever it arrives, however long the browser was offline.
  offline: 'anytime',
  emits: ['outreach.touch.saved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    return once(async () => {
      const groupId = input.group ? await keepGroup(ctx, input.platform, input.group) : null;
      const profile = await reachedProfile(
        ctx,
        {
          platform: input.platform,
          profile: input.profile,
          name: input.name,
          kind: input.kind,
          groupId,
        },
        me,
        at,
      );
      const noted = await notedAlready(ctx, me, profile.id, input, at);
      if (noted)
        return {
          touchId: noted,
          profileId: profile.id,
          personId: profile.personId,
          step: null,
          repeated: true,
        };
      const step = input.kind === 'message' ? await messageStep(ctx, me, profile, input, at) : null;
      const [row] = await ctx.tx
        .insert(touches)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          profileId: profile.id,
          userId: me,
          kind: input.kind,
          step,
          groupId,
          postUrl: input.postUrl,
          threadKey: input.threadKey,
          at,
        })
        .returning({ id: touches.id });
      await ctx.emit({
        type: 'outreach.touch.saved',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: {
          platform: input.platform,
          touchId: row!.id,
          kind: input.kind,
          step,
          personId: profile.personId,
        },
      });
      return {
        touchId: row!.id,
        profileId: profile.id,
        personId: profile.personId,
        step,
        repeated: false,
      };
    });
  },
});

type Counts = {
  readonly people: number;
  readonly friend_requests: number;
  readonly likes: number;
  readonly comments: number;
  readonly chats_started: number;
  readonly follow_ups: number;
  readonly today_friend_request: number;
  readonly today_first_message: number;
  readonly today_follow_up: number;
  readonly today_comment: number;
  readonly today_like: number;
};

type Listed = {
  readonly profile_id: string;
  readonly person_id: string | null;
  readonly name: string;
  readonly url: string;
  readonly group_id: string | null;
  readonly group_name: string | null;
  readonly group_url: string | null;
  readonly requested_at: Date | string | null;
  readonly liked_at: Date | string | null;
  readonly commented_at: Date | string | null;
  readonly messaged_at: Date | string | null;
  readonly replied_at: Date | string | null;
  readonly last_at: Date | string;
  readonly requested: boolean;
  readonly warmed: boolean;
  readonly started: boolean;
  readonly replied: boolean;
};

const iso = (at: Date | string) => new Date(at).toISOString();
const isoOrNull = (at: Date | string | null) => (at === null ? null : iso(at));

/** The person's own steps of one kind since the day began, for the daily limits, whoever's the panel shows. */
const todayCount = (column: 'kind' | 'step', value: string, me: string, since: string) =>
  sql`(count(*) filter (where ${sql.raw(`t.${column}`)} = ${value} and t.user_id = ${me}
    and t.at >= ${since}::timestamptz))::int`;

export const activity = defineAddonQuery(outreachAddon, {
  name: 'outreach.activity',
  description:
    'What the person did on social media in a stretch of days, as the extension noted it: the people reached, friend requests, likes, comments, chats started, follow-ups and replies, by group and person; and their day so far against the daily limits. Owners and admins can see everyone’s.',
  input: ActivityInput,
  output: ActivityOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    if (input.everyone && !scopeCan(ctx.scope, 'outreach.manage' as Permission))
      throw HfosError.forbidden(
        'Only owners and admins (Run Social Outreach) see the whole team’s outreach. Yours is under You.',
        'outreach_activity_everyone',
      );
    const timezone = await workspaceTimezone(ctx.tx, ws);
    const today = localDateOf(Date.now(), timezone);
    const from = new Date(
      startOfLocalDay(addDays(today, 1 - ACTIVITY_PERIODS[input.period].days), timezone),
    ).toISOString();
    const todayFrom = new Date(startOfLocalDay(today, timezone)).toISOString();
    const whose = input.everyone ? sql`true` : sql`t.user_id = ${me}`;

    const [counts] = await rows<Counts>(
      ctx.tx,
      sql`select
            count(distinct t.profile_id)::int as people,
            count(*) filter (where t.kind = 'friend_request')::int as friend_requests,
            count(*) filter (where t.kind = 'like')::int as likes,
            count(*) filter (where t.kind = 'comment')::int as comments,
            count(*) filter (where t.step = 'first_message')::int as chats_started,
            count(*) filter (where t.step = 'follow_up')::int as follow_ups,
            ${todayCount('kind', 'friend_request', me, todayFrom)} as today_friend_request,
            ${todayCount('step', 'first_message', me, todayFrom)} as today_first_message,
            ${todayCount('step', 'follow_up', me, todayFrom)} as today_follow_up,
            ${todayCount('kind', 'comment', me, todayFrom)} as today_comment,
            ${todayCount('kind', 'like', me, todayFrom)} as today_like
          from addon_outreach.touches t
          where t.workspace_id = ${ws} and t.at >= ${from}::timestamptz and ${whose}`,
    );

    // Everyone reached in the stretch, or who wrote back in it: the last of each step to them (ever), and the group
    // they were found in (the first step's that said, else the profile's).
    const listed = await rows<Listed>(
      ctx.tx,
      sql`with mine as (
            select t.profile_id, t.kind, t.step, t.group_id, t.thread_key, t.at
            from addon_outreach.touches t
            where t.workspace_id = ${ws} and ${whose}
          ),
          reached as (
            select m.profile_id,
              max(m.at) filter (where m.kind = 'friend_request') as requested_at,
              max(m.at) filter (where m.kind = 'like') as liked_at,
              max(m.at) filter (where m.kind = 'comment') as commented_at,
              max(m.at) filter (where m.kind = 'message') as messaged_at,
              max(m.at) as touched_at,
              (array_agg(m.group_id order by m.at) filter (where m.group_id is not null))[1] as group_id,
              bool_or(m.at >= ${from}::timestamptz) as recent,
              bool_or(m.at >= ${from}::timestamptz and m.kind = 'friend_request') as requested,
              bool_or(m.at >= ${from}::timestamptz and m.kind in ('like', 'comment')) as warmed,
              bool_or(m.at >= ${from}::timestamptz and m.step = 'first_message') as started
            from mine m
            group by m.profile_id
          ),
          -- When they first wrote back: the first-saved time of a message from them after one from us, in a chat
          -- with them saved here (by its customer, or the chat a message went in).
          replies as (
            select p.id as profile_id, min(r.at) as replied_at
            from reached e
            join addon_outreach.profiles p on p.id = e.profile_id
            join addon_outreach.threads c on c.workspace_id = p.workspace_id and c.platform = p.platform
              and ${input.everyone ? sql`true` : sql`c.owner_user_id = ${me}`}
              and (c.person_id = p.person_id
                or c.thread_key in (select m.thread_key from mine m where m.profile_id = p.id))
            cross join lateral (
              select min((x.m ->> 'savedAt')::timestamptz) as at
              from jsonb_array_elements(c.messages) with ordinality as x(m, i)
              where x.m ->> 'from' = 'them'
                and x.i > (select min(y.i) from jsonb_array_elements(c.messages) with ordinality as y(m, i)
                           where y.m ->> 'from' = 'me')
            ) r
            where r.at is not null
            group by p.id
          )
          select e.profile_id, p.person_id,
            coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name, p.url,
            g.id as group_id, g.name as group_name, g.url as group_url,
            e.requested_at, e.liked_at, e.commented_at, e.messaged_at, r.replied_at,
            greatest(e.touched_at, r.replied_at) as last_at,
            e.requested, e.warmed, e.started,
            coalesce(r.replied_at >= ${from}::timestamptz, false) as replied
          from reached e
          join addon_outreach.profiles p on p.id = e.profile_id
          left join app.people pp on pp.id = p.person_id
          left join replies r on r.profile_id = e.profile_id
          left join addon_outreach.groups g on g.id = coalesce(e.group_id, p.group_id)
          where e.recent or r.replied_at >= ${from}::timestamptz
          order by last_at desc, e.profile_id`,
    );

    const byGroup = new Map<string, ActivityOutput['groups'][number]>();
    for (const l of listed) {
      if (!l.group_id) continue;
      const g = byGroup.get(l.group_id) ?? {
        groupId: l.group_id,
        name: l.group_name,
        url: l.group_url ?? '',
        people: 0,
        friendRequests: 0,
        warmedUp: 0,
        chatsStarted: 0,
        replies: 0,
      };
      byGroup.set(l.group_id, {
        ...g,
        people: g.people + 1,
        friendRequests: g.friendRequests + Number(l.requested),
        warmedUp: g.warmedUp + Number(l.warmed),
        chatsStarted: g.chatsStarted + Number(l.started),
        replies: g.replies + Number(l.replied),
      });
    }
    const c = counts!;
    return {
      from,
      timezone,
      everyone: input.everyone,
      numbers: {
        people: c.people,
        friendRequests: c.friend_requests,
        likes: c.likes,
        comments: c.comments,
        chatsStarted: c.chats_started,
        followUps: c.follow_ups,
        replies: listed.filter((l) => l.replied).length,
      },
      today: {
        friend_request: c.today_friend_request,
        first_message: c.today_first_message,
        follow_up: c.today_follow_up,
        comment: c.today_comment,
        like: c.today_like,
      },
      groups: [...byGroup.values()]
        .sort((a, b) => b.people - a.people || (a.name ?? '').localeCompare(b.name ?? ''))
        .slice(0, ACTIVITY_GROUPS),
      people: listed.slice(0, ACTIVITY_PEOPLE).map((l) => ({
        profileId: l.profile_id,
        personId: l.person_id,
        name: l.name,
        url: l.url,
        group: l.group_id ? { name: l.group_name, url: l.group_url ?? '' } : null,
        requestedAt: isoOrNull(l.requested_at),
        likedAt: isoOrNull(l.liked_at),
        commentedAt: isoOrNull(l.commented_at),
        messagedAt: isoOrNull(l.messaged_at),
        repliedAt: isoOrNull(l.replied_at),
        lastAt: iso(l.last_at),
      })),
      morePeople: Math.max(0, listed.length - ACTIVITY_PEOPLE),
    };
  },
});

export const activityCommands = [touchSave] as const;
export const activityQueries = [activity] as const;
