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
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import type { CommandContext, QueryContext } from '../../../kernel/types';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  ACTIVITY_GROUPS,
  ACTIVITY_PEOPLE,
  ACTIVITY_PERIODS,
  ActivityInput,
  ActivityOutput,
  TOUCHED_POSTS_PAGE,
  TouchedPostsInput,
  TouchedPostsOutput,
  TouchSaveInput,
  TouchSaveOutput,
  type ActivityTopic,
  type GroupRef,
  type TouchKind,
  type TouchStep,
} from '../activity';
import { DONT_PITCH_TAG } from '../limits';
import { byResults } from '../results';
import { outreachAddon } from '../manifest';
import { NETWORKS } from '../networks';
import type { Platform } from '../playbooks';
import type { NeedStep } from '../waiting-words';
import { groups, networkStarts, threads, touches } from '../tables';
import {
  dontPitchOf,
  neverContactOf,
  inWorkspace,
  keepFriendStates,
  keptProfile,
  once,
  seesEveryone,
  type Profile,
  type ProfileKey,
} from './common';
import { limitsFor } from './automation';
import { clearNeeds } from './needs';
import { claimGroup, claimProfile } from './owners';
import { notePartnerWarmed } from './partners';
import { tally } from './tallies';
import { slowsNow, warningOf } from './tidy';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The group a step came from, kept the first time it's seen: by its number or the name in its link, whichever the
 * link showed, and a later look fills in the other (unless another kept group has it) and its latest name.
 */
export async function keepGroup(
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
 * The profile a step was to: the one kept already, or a new one with no customer. A later look fills in the group
 * it was first found in, and a friend request says so where the profile said they weren't friends or didn't know.
 */
function reachedProfile(
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
  const requested = input.kind === 'friend_request';
  return keptProfile(
    ctx,
    input,
    me,
    at,
    { friendship: requested ? 'request_sent' : 'unknown', groupId: input.groupId },
    (had) => ({
      ...(!had.groupId && input.groupId ? { groupId: input.groupId } : {}),
      ...(requested && (had.friendship === 'not_friends' || had.friendship === 'unknown')
        ? { friendship: 'request_sent' as const, lastSeenBy: me, lastSeenAt: at }
        : {}),
    }),
  );
}

/**
 * The same step noted already, which isn't counted twice: the same post liked again, another friend request to them
 * within a day (sent, cancelled and sent again), or a recommendation of a business already recommended (Alignable
 * keeps one each). Comments and messages each count.
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
        : input.kind === 'recommend'
          ? eq(touches.kind, 'recommend')
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

/** The steps the extension hands over that each step noted takes care of. */
const NEED_FOR: Readonly<Record<TouchKind, readonly NeedStep[]>> = {
  friend_request: ['friend_request'],
  like: ['warm_up'],
  comment: ['comment'],
  message: ['message'],
  recommend: [],
};

export const touchSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.touch.save',
  description:
    'Note a step the person took on a social network themselves, as the extension saw it: a friend request, a like, a comment, a message or a recommendation on Alignable, to whom and from which group. Adds nobody to Contacts.',
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
    if (input.kind === 'recommend' && !NETWORKS[input.platform].recommends)
      throw HfosError.rule(
        'outreach_no_recommendations',
        422,
        `${NETWORKS[input.platform].name} has no recommendations to note. Only Alignable’s are noted.`,
      );
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
      const off = await neverContactOf(ctx, profile);
      if (off)
        throw HfosError.rule(
          'outreach_never_contact',
          422,
          `${input.name} is on the Never contact list, so steps to them aren’t counted as outreach. To count them, take them off it in Social Outreach → People → Friends.`,
        );
      // Vouching for a customer isn't pitching them: Don't pitch holds back the outreach, never a recommendation.
      const never = input.kind === 'recommend' ? null : await dontPitchOf(ctx, profile);
      if (never)
        throw HfosError.rule(
          'outreach_dont_pitch',
          422,
          never.tagged && !profile.dontPitch
            ? `${input.name} is tagged ${DONT_PITCH_TAG} in Contacts, so steps to them aren’t counted as outreach. To count them, take the tag off them in Contacts.`
            : `${input.name} is on the Don’t pitch list, so steps to them aren’t counted as outreach. To count them, take them off it in Social Outreach → Friends.`,
        );
      if (input.kind === 'friend_request')
        await keepFriendStates(ctx, me, [{ profileId: profile.id, state: 'request_sent' }], at);
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
      // The extension on its own goes from the list for today, which doesn't say the group: they were found in
      // the one their profile was first saved from.
      const fromGroup = groupId ?? (input.auto ? profile.groupId : null);
      const [row] = await ctx.tx
        .insert(touches)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          profileId: profile.id,
          userId: me,
          kind: input.kind,
          step,
          groupId: fromGroup,
          postUrl: input.postUrl,
          threadKey: input.threadKey,
          auto: input.auto,
          // Only what the extension did on its own keeps the words: never what the person wrote.
          ...(input.auto && (input.kind === 'like' || input.kind === 'comment')
            ? {
                postText: input.postText,
                commentText: input.kind === 'comment' ? input.commentText : null,
                why: input.kind === 'like' ? input.why : null,
              }
            : {}),
          at,
        })
        .returning({ id: touches.id });
      // What the extension did on its own counts (decision 140); what the person did themselves doesn't.
      if (input.auto) await tally(ctx, me, input.platform, input.kind, 1, at);
      // The first step on a network starts the person's 2 weeks at half limits there (decision 96): the earliest
      // noted, as a step taken offline can arrive after a later one.
      await ctx.tx
        .insert(networkStarts)
        .values({
          workspaceId: ctx.scope.workspaceId!,
          userId: me,
          platform: input.platform,
          firstAt: at,
        })
        .onConflictDoUpdate({
          target: [networkStarts.workspaceId, networkStarts.userId, networkStarts.platform],
          set: { firstAt: at },
          setWhere: sql`${networkStarts.firstAt} > ${at.toISOString()}::timestamptz`,
        });
      // Whoever reached them first, and worked the group first, has them (decision 107).
      await claimProfile(ctx, me, profile.id, at);
      await claimGroup(ctx, me, fromGroup, at);
      // A like or a comment on someone just found as a partner warms them up (decision 81).
      if (input.kind === 'like' || input.kind === 'comment')
        await notePartnerWarmed(ctx, me, profile.id, at);
      // A step the extension handed to the person, taken now: it's done (Waiting for you).
      await clearNeeds(
        ctx,
        me,
        {
          profileId: profile.id,
          steps: NEED_FOR[input.kind],
          postUrl: input.kind === 'comment' ? input.postUrl : null,
        },
        at,
      );
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

export type Listed = {
  readonly profile_id: string;
  readonly person_id: string | null;
  readonly platform: Platform;
  readonly name: string;
  readonly url: string;
  readonly group_id: string | null;
  readonly group_name: string | null;
  readonly group_url: string | null;
  /** The hashtag, phrase or kind of business they were found with, the latest find's (decision 116). */
  readonly found_words: string | null;
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
  readonly demo: boolean;
};

/**
 * Everyone reached since `from`, or who wrote back or booked a demo since: the last of each step to them (ever), the
 * group they were found in (the first step's that said, else the profile's), the words they were found with, when
 * they first wrote back, and what of it was since `from`. The person's own steps, or everyone's.
 */
export async function reachedPeople(
  ctx: QueryContext | CommandContext,
  {
    from,
    me,
    everyone,
  }: { readonly from: string; readonly me: string; readonly everyone: boolean },
): Promise<Listed[]> {
  const ws = ctx.scope.workspaceId!;
  const whose = (column: string) => (everyone ? sql`true` : sql`${sql.raw(column)} = ${me}`);
  return rows<Listed>(
    ctx.tx,
    sql`with mine as (
          select t.profile_id, t.kind, t.step, t.group_id, t.thread_key, t.at
          from addon_outreach.touches t
          where t.workspace_id = ${ws} and ${whose('t.user_id')}
        ),
        reached as (
          select m.profile_id,
            max(m.at) filter (where m.kind = 'friend_request') as requested_at,
            max(m.at) filter (where m.kind = 'like') as liked_at,
            max(m.at) filter (where m.kind = 'comment') as commented_at,
            max(m.at) filter (where m.kind = 'message') as messaged_at,
            min(m.at) as first_at,
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
        -- with them saved here (by its customer, or the chat a message went in); a reply the extension saw
        -- (decision 22); or a chat read in Messenger or brought in whose last message is theirs. Only what came
        -- after outreach to them began counts: a chat saved to their card keeps each message's own time, which
        -- can be years before it (outreach.chat.keep).
        wrote as (
          select p.id as profile_id, r.at
          from reached e
          join addon_outreach.profiles p on p.id = e.profile_id
          join addon_outreach.threads c on c.workspace_id = p.workspace_id and c.platform = p.platform
            and ${whose('c.owner_user_id')}
            and (c.person_id = p.person_id
              or c.thread_key in (select m.thread_key from mine m where m.profile_id = p.id))
          cross join lateral (
            select min((x.m ->> 'savedAt')::timestamptz) as at
            from jsonb_array_elements(c.messages) with ordinality as x(m, i)
            where x.m ->> 'from' = 'them'
              and (x.m ->> 'savedAt')::timestamptz > e.first_at
              and x.i > (select min(y.i) from jsonb_array_elements(c.messages) with ordinality as y(m, i)
                         where y.m ->> 'from' = 'me')
          ) r
          where r.at is not null
          union all
          select r.profile_id, r.seen_at
          from addon_outreach.replies r
          join reached e on e.profile_id = r.profile_id
          where r.workspace_id = ${ws} and ${whose('r.user_id')}
          union all
          select c.profile_id, c.last_at
          from addon_outreach.file_chats c
          join reached e on e.profile_id = c.profile_id
          where c.workspace_id = ${ws} and ${whose('c.user_id')}
            and not c.last_from_me and c.last_at > e.first_at
        ),
        replies as (
          select w.profile_id, min(w.at) as replied_at from wrote w group by w.profile_id
        ),
        -- A demo booked (decision 24), through the demo link or marked, and not taken back.
        booked as (
          select d.profile_id, max(d.at) as demo_at
          from addon_outreach.demos d
          join reached e on e.profile_id = d.profile_id
          where d.workspace_id = ${ws} and d.undone_at is null and ${whose('d.user_id')}
          group by d.profile_id
        )
        select e.profile_id, p.person_id, p.platform,
          coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name, p.url,
          g.id as group_id, g.name as group_name, g.url as group_url,
          (select f.words from addon_outreach.finds f
            where f.workspace_id = p.workspace_id and f.profile_id = p.id and ${whose('f.user_id')}
              and f.words is not null
            order by f.found_at desc limit 1) as found_words,
          e.requested_at, e.liked_at, e.commented_at, e.messaged_at, r.replied_at,
          greatest(e.touched_at, r.replied_at) as last_at,
          e.requested, e.warmed, e.started,
          coalesce(r.replied_at >= ${from}::timestamptz, false) as replied,
          coalesce(b.demo_at >= ${from}::timestamptz, false) as demo
        from reached e
        join addon_outreach.profiles p on p.id = e.profile_id
        left join app.people pp on pp.id = p.person_id
        left join replies r on r.profile_id = e.profile_id
        left join booked b on b.profile_id = e.profile_id
        left join addon_outreach.groups g on g.id = coalesce(e.group_id, p.group_id)
        where e.recent or r.replied_at >= ${from}::timestamptz or b.demo_at >= ${from}::timestamptz
        order by last_at desc, e.profile_id`,
  );
}

/** The people reached, by the group they were found in (./results.ts): how many, and what came of it. */
export function resultsByGroup(
  listed: readonly Listed[],
): Map<string, ActivityOutput['groups'][number]> {
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
      demos: 0,
    };
    byGroup.set(l.group_id, {
      ...g,
      people: g.people + 1,
      friendRequests: g.friendRequests + Number(l.requested),
      warmedUp: g.warmedUp + Number(l.warmed),
      chatsStarted: g.chatsStarted + Number(l.started),
      replies: g.replies + Number(l.replied),
      demos: g.demos + Number(l.demo),
    });
  }
  return byGroup;
}

/**
 * The people reached, by the hashtag, phrase or kind of business they were found with on a network (decision 116): how
 * many, and what came of it. The same words on two networks are two rows; the same words written another way are one.
 */
export function resultsByTopic(listed: readonly Listed[]): Map<string, ActivityTopic> {
  const byTopic = new Map<string, ActivityTopic>();
  for (const l of listed) {
    const words = l.found_words?.trim();
    if (!words) continue;
    const key = `${l.platform} ${words.toLowerCase()}`;
    const t = byTopic.get(key) ?? {
      platform: l.platform,
      words,
      people: 0,
      friendRequests: 0,
      warmedUp: 0,
      chatsStarted: 0,
      replies: 0,
      demos: 0,
    };
    byTopic.set(key, {
      ...t,
      people: t.people + 1,
      friendRequests: t.friendRequests + Number(l.requested),
      warmedUp: t.warmedUp + Number(l.warmed),
      chatsStarted: t.chatsStarted + Number(l.started),
      replies: t.replies + Number(l.replied),
      demos: t.demos + Number(l.demo),
    });
  }
  return byTopic;
}

/** Where a stretch of `days` days ending today starts: midnight in the business's time zone. */
export async function periodStart(
  ctx: QueryContext | CommandContext,
  days: number,
  timezone?: string,
): Promise<string> {
  const tz = timezone ?? (await workspaceTimezone(ctx.tx, ctx.scope.workspaceId!));
  return new Date(
    startOfLocalDay(addDays(localDateOf(Date.now(), tz), 1 - days), tz),
  ).toISOString();
}

/** From the beginning: what a group has brought ever. */
export const EVER = new Date(0).toISOString();

const iso = (at: Date | string) => new Date(at).toISOString();
const isoOrNull = (at: Date | string | null) => (at === null ? null : iso(at));

/** The person's own steps of one kind since the day began, for the daily limits, whoever's the panel shows. */
/** The person's own steps today on Facebook, whose daily limits the panel shows them against. */
const todayCount = (column: 'kind' | 'step', value: string, me: string, since: string) =>
  sql`(count(*) filter (where ${sql.raw(`t.${column}`)} = ${value} and t.user_id = ${me}
    and tp.platform = 'facebook' and t.at >= ${since}::timestamptz))::int`;

export const activity = defineAddonQuery(outreachAddon, {
  name: 'outreach.activity',
  description:
    'What the person did on social media in a stretch of days, as the extension noted it: the people reached, friend requests, likes, comments, chats started, follow-ups and replies, by group and person; their day so far against the daily limits; and their Partners list’s asks, yeses, calls and partners made. Owners and admins can see everyone’s.',
  input: ActivityInput,
  output: ActivityOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_activity',
    keywords: [
      'what I did on facebook',
      'friend requests sent',
      'likes',
      'comments',
      'daily limits',
    ],
  },
  // The worker asks on a person's behalf for the weekly report (../results.ts).
  actors: ['human', 'system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has outreach of their own.');
    const ws = ctx.scope.workspaceId!;
    if (input.everyone && !(await seesEveryone(ctx, me)))
      throw HfosError.forbidden(
        'Only owners and admins (Run Social Outreach) see the whole team’s outreach. Yours is under You.',
        'outreach_activity_everyone',
      );
    const timezone = await workspaceTimezone(ctx.tx, ws);
    const today = localDateOf(Date.now(), timezone);
    const from = await periodStart(ctx, ACTIVITY_PERIODS[input.period].days, timezone);
    const todayFrom = new Date(startOfLocalDay(today, timezone)).toISOString();
    const whose = input.everyone ? sql`true` : sql`t.user_id = ${me}`;
    // The day against the limits is Facebook's, where the extension works yet: only its warning halves them.
    const warning = await warningOf(ctx, me, 'facebook', new Date(todayFrom));

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
          join addon_outreach.profiles tp on tp.id = t.profile_id
          where t.workspace_id = ${ws} and t.at >= ${from}::timestamptz and ${whose}`,
    );

    const listed = await reachedPeople(ctx, { from, me, everyone: input.everyone });
    const c = counts!;
    // The person's own Partners list: each person's is their own (decision 81).
    const [partnered] = input.everyone
      ? []
      : await rows<{
          listed: number;
          asked: number;
          interested: number;
          calls: number;
          partners: number;
        }>(
          ctx.tx,
          sql`select count(*) filter (where pa.stage is not null)::int as listed,
                count(*) filter (where pa.asked_at >= ${from}::timestamptz)::int as asked,
                count(*) filter (where pa.interested_at >= ${from}::timestamptz)::int as interested,
                count(*) filter (where pa.call_at >= ${from}::timestamptz)::int as calls,
                count(*) filter (where pa.partner_at >= ${from}::timestamptz)::int as partners
              from addon_outreach.partners pa
              where pa.workspace_id = ${ws} and pa.user_id = ${me}`,
        );
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
        demos: listed.filter((l) => l.demo).length,
      },
      today: {
        friend_request: c.today_friend_request,
        first_message: c.today_first_message,
        follow_up: c.today_follow_up,
        comment: c.today_comment,
        like: c.today_like,
      },
      limits: await limitsFor(ctx, me, slowsNow(warning)),
      warning,
      partners:
        partnered && (partnered.listed || partnered.asked)
          ? {
              asked: partnered.asked,
              interested: partnered.interested,
              calls: partnered.calls,
              partners: partnered.partners,
            }
          : null,
      groups: [...resultsByGroup(listed).values()]
        .sort(
          (a, b) =>
            byResults(a, b) || b.people - a.people || (a.name ?? '').localeCompare(b.name ?? ''),
        )
        .slice(0, ACTIVITY_GROUPS),
      topics: [...resultsByTopic(listed).values()]
        .sort((a, b) => byResults(a, b) || b.people - a.people || a.words.localeCompare(b.words))
        .slice(0, ACTIVITY_GROUPS),
      people: listed.slice(0, ACTIVITY_PEOPLE).map((l) => ({
        profileId: l.profile_id,
        personId: l.person_id,
        name: l.name,
        url: l.url,
        platform: l.platform,
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

export const touchedPosts = defineAddonQuery(outreachAddon, {
  name: 'outreach.activity.posts',
  description:
    'The posts the person liked and commented on in a stretch of days, the latest first, as the extension noted them: whose post, a link to it, what it said, and the comment the extension posted on its own and why it picked a post to like. Owners and admins can see everyone’s.',
  input: TouchedPostsInput,
  output: TouchedPostsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_activity_posts',
    keywords: ['posts liked', 'comments posted'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has outreach of their own.');
    const ws = ctx.scope.workspaceId!;
    if (input.everyone && !(await seesEveryone(ctx, me)))
      throw HfosError.forbidden(
        'Only owners and admins (Run Social Outreach) see the whole team’s outreach. Yours is under You.',
        'outreach_activity_everyone',
      );
    const from = await periodStart(ctx, ACTIVITY_PERIODS[input.period].days);
    const whose = input.everyone ? sql`true` : sql`t.user_id = ${me}`;
    const kinds =
      input.kind === 'all' ? sql`t.kind in ('like', 'comment')` : sql`t.kind = ${input.kind}`;
    const before = input.before ? sql`t.at < ${input.before}::timestamptz` : sql`true`;
    const found = await rows<{
      id: string;
      kind: 'like' | 'comment';
      at: Date | string;
      profile_id: string;
      person_id: string | null;
      name: string;
      url: string;
      post_url: string | null;
      post_text: string | null;
      comment_text: string | null;
      why: string | null;
      auto: boolean;
      group_name: string | null;
      group_url: string | null;
      by: string | null;
    }>(
      ctx.tx,
      // A post found in a group (Find posts) keeps what it said: a comment on one shows it.
      sql`select t.id, t.kind, t.at, t.profile_id, p.person_id,
            coalesce(nullif(btrim(pp.first_name || ' ' || pp.last_name), ''), p.name) as name, p.url,
            t.post_url, coalesce(t.post_text, left(po.body, 300)) as post_text, t.comment_text, t.why, t.auto,
            g.name as group_name, g.url as group_url,
            ${input.everyone ? sql`coalesce(nullif(btrim(u.full_name), ''), u.email)` : sql`null::text`} as by
          from addon_outreach.touches t
          join addon_outreach.profiles p on p.id = t.profile_id
          left join app.people pp on pp.id = p.person_id
          left join addon_outreach.groups g on g.id = coalesce(t.group_id, p.group_id)
          left join addon_outreach.posts po on po.workspace_id = t.workspace_id and po.user_id = t.user_id
            and po.url = t.post_url
          left join app.users u on u.id = t.user_id
          where t.workspace_id = ${ws} and ${whose} and ${kinds} and ${before}
            and t.at >= ${from}::timestamptz
          order by t.at desc, t.id
          limit ${TOUCHED_POSTS_PAGE + 1}`,
    );
    const shown = found.slice(0, TOUCHED_POSTS_PAGE);
    return {
      from,
      everyone: input.everyone,
      posts: shown.map((r) => ({
        touchId: r.id,
        kind: r.kind,
        at: iso(r.at),
        profileId: r.profile_id,
        personId: r.person_id,
        name: r.name,
        profileUrl: r.url,
        postUrl: r.post_url,
        postText: r.post_text,
        commentText: r.comment_text,
        why: r.why,
        auto: r.auto,
        group: r.group_url ? { name: r.group_name, url: r.group_url } : null,
        by: r.by,
      })),
      next: found.length > TOUCHED_POSTS_PAGE ? iso(shown.at(-1)!.at) : null,
    };
  },
});

export const activityCommands = [touchSave] as const;
export const activityQueries = [activity, touchedPosts] as const;
