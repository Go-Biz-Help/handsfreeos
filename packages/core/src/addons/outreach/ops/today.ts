/**
 * Today (../today.ts): the person's list for the day on Facebook, worked out each time it's asked for from the
 * groups, friends, chats and steps HandsFreeOS keeps. Nothing is saved: a step the person takes is noted by the
 * extension, and that takes it off the list.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { userIdOf } from '../../../kernel/actor';
import { defineAddonQuery } from '../../server';
import {
  MESSAGE_KINDS,
  WARM_UP_WAIT_HOURS,
  WARM_UP_WINDOW_DAYS,
  autoKinds,
  messageKinds,
} from '../automation';
import { demoLink, demoRef } from '../demos';
import { bestFit, type Fit, type FitPlaybook } from '../fit';
import type { GroupCheckState } from '../group-checks';
import { dailyLimitsNow, type DailyStep } from '../limits';
import { outreachAddon } from '../manifest';
import {
  DEFAULT_PACE,
  leftToday,
  TODAY_MOST,
  TODAY_WINDOW_DAYS,
  TodayInput,
  todayLimits,
  TodayOutput,
  TODAY_POST_MOST,
  type TodayItem,
} from '../today';
import { POST_FRESH_DAYS } from '../posts';
import { RECONNECT_QUIET_DAYS } from '../checks';
import { WARM_LEAD_DAYS } from '../helpful';
import type { GroupResults } from '../results';
import { EVER, reachedPeople, resultsByGroup } from './activity';
import { automationOf } from './automation';
import {
  chatKey,
  countryLetsSql,
  countryRuleOf,
  inPlay,
  inWorkspace,
  pitchable,
  recentOf,
  type Ctx,
} from './common';
import { playbooksInUse } from './friends';
import { readinessFor } from './readiness';
import { groupFitOf } from './group-checks';
import { sendsToday } from './sends';
import { slowsNow, startOfToday, warningOf } from './tidy';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const NONE_DONE: Record<DailyStep, number> = {
  friend_request: 0,
  first_message: 0,
  follow_up: 0,
  comment: 0,
  like: 0,
};

/**
 * Each person's steps since the start of today that count against the daily limits, as Today counts them; the live
 * view (./live.ts) counts with it too, so the two never disagree.
 */
export async function dayCounts(
  ctx: Ctx,
  userIds: readonly string[],
  todayFrom: Date,
): Promise<Map<string, Record<DailyStep, number>>> {
  const counted = new Map(userIds.map((id) => [id, { ...NONE_DONE }]));
  if (!userIds.length) return counted;
  const found = await rows<{ user_id: string } & Record<DailyStep, number>>(
    ctx.tx,
    sql`select user_id, count(*) filter (where kind = 'friend_request')::int as friend_request,
          count(*) filter (where step = 'first_message')::int as first_message,
          count(*) filter (where step = 'follow_up')::int as follow_up,
          count(*) filter (where kind = 'comment')::int as comment,
          count(*) filter (where kind = 'like')::int as "like"
        from addon_outreach.touches
        where workspace_id = ${ctx.scope.workspaceId!}
          and user_id = any (${`{${userIds.join(',')}}`}::uuid[])
          and at >= ${todayFrom.toISOString()}::timestamptz
        group by user_id`,
  );
  for (const { user_id, ...done } of found) counted.set(user_id, done);
  return counted;
}
/** The most people from groups weighed for requests at once. */
const CANDIDATES_MOST = 500;

export { pitchable };

/** A friend request the person got, as Today and Waiting for you weigh it. */
export type RequestGot = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly intro: string[];
  readonly mutual_friends: number | null;
  readonly group_name: string | null;
};

/** How a request the person got fits the playbooks in use. */
export const requestFit = (playbooks: readonly FitPlaybook[], p: RequestGot): Fit =>
  bestFit(playbooks, { lines: p.intro, mutualFriends: p.mutual_friends, groupName: p.group_name });

/**
 * The requests the person got that Today lists as **Confirm their request** (decision 30): with a playbook in use,
 * from people who are pitched and fit one well, the best first, as many as Today lists of a kind; the rest of the good
 * fits on a later day. Waiting for you (./waiting.ts) lists the requests lately that aren't good fits for this, as the
 * person's to decide.
 */
export async function requestsToConfirm(
  ctx: Ctx,
  me: string,
  playbooks: readonly FitPlaybook[],
): Promise<{ readonly p: RequestGot; readonly fit: Fit }[]> {
  if (!playbooks.length) return [];
  // The business's country setting skips some (decision 61): they're on the Skipped for country list instead.
  const lets = countryLetsSql(await countryRuleOf(ctx), 'p');
  const asked = await rows<RequestGot>(
    ctx.tx,
    sql`select p.id, p.name, p.url, p.intro, p.mutual_friends, g.name as group_name
        from addon_outreach.friends f
        join addon_outreach.profiles p on p.id = f.profile_id
        left join addon_outreach.groups g on g.id = p.group_id
        where f.workspace_id = ${ctx.scope.workspaceId!} and f.user_id = ${me}
          and f.state = 'request_received' and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
        order by f.since desc limit ${CANDIDATES_MOST}`,
  );
  return asked
    .map((p) => ({ p, fit: requestFit(playbooks, p) }))
    .filter(({ fit }) => fit.level === 'good')
    .sort((a, b) => b.fit.score - a.fit.score || a.p.name.localeCompare(b.p.name))
    .slice(0, TODAY_MOST);
}

export const today = defineAddonQuery(outreachAddon, {
  name: 'outreach.today',
  description:
    'The person’s list for today on Facebook, for them or the extension to do: requests they got from people who fit a playbook to confirm, posts to like before a friend request, friend requests to people found in the business’s groups who fit a playbook (never anyone who runs a group, is on Don’t pitch or is in Contacts), a first message to new friends who accepted, friends the AI found a good fit to reconnect with, people ready for the offer to pitch, follow-ups to likely prospects gone quiet, replies owed and posts to comment on; with today’s steps against the daily limits. Nobody marked not a fit is reached but with a reply.',
  input: TodayInput,
  output: TodayOutput,
  permission: 'outreach.use',
  // The worker asks on a person's behalf for the morning push (decision 22).
  actors: ['human', 'system'],
  scope: inWorkspace,
  async handler(ctx, _input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has a list for today.');
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const todayStart = await startOfToday(ctx, now);
    const todayFrom = todayStart.toISOString();
    const warning = await warningOf(ctx, me, todayStart, now);
    const done = (await dayCounts(ctx, [me], todayStart)).get(me)!;
    const { settings, wheels, rules } = await automationOf(ctx, me, now);
    // The business's own, halved after a warning from Facebook, and on training wheels.
    const limits = todayLimits(
      done,
      dailyLimitsNow(slowsNow(warning, now) || wheels.on, rules.dailyLimits),
    );
    // Until they're ready (decision 63), the list keeps only replies owed to people who wrote to them, and nothing is
    // done on its own: Get ready shows in place of the rest.
    const ready = (await readinessFor(ctx, me)).ready;
    const requestsOff = warning !== null && new Date(warning.requestsFrom).getTime() > now;
    const playbooks = await playbooksInUse(ctx);
    // Who the business's country setting lets be reached (decision 61): everything new on the list but a reply owed.
    const lets = countryLetsSql(await countryRuleOf(ctx), 'p');
    const pace = {
      messageAfterDays: Math.min(
        ...playbooks.map((p) => p.details.pace.messageAfterDays),
        playbooks.length ? Infinity : DEFAULT_PACE.messageAfterDays,
      ),
      followUpAfterDays: Math.min(
        ...playbooks.map((p) => p.details.pace.followUpAfterDays),
        playbooks.length ? Infinity : DEFAULT_PACE.followUpAfterDays,
      ),
    };
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    const items: TodayItem[] = [];
    const item = (more: Partial<TodayItem> & Pick<TodayItem, 'kind' | 'name'>): TodayItem => ({
      profileId: null,
      profileUrl: null,
      chatId: null,
      threadKey: null,
      postId: null,
      postUrl: null,
      posted: null,
      post: null,
      asking: false,
      why: [],
      summary: null,
      nextStep: null,
      playbookName: null,
      demoLink: null,
      send: null,
      personId: null,
      demoBooked: false,
      recent: [],
      ...more,
    });
    // The demo link for a message (decision 24): the first playbook in use with a link, by name.
    const linked = [...playbooks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((p) => p.details.link);
    const demoFor = (profileId: string | null) =>
      linked && profileId ? demoLink(linked.details.link, demoRef(me, profileId)) : null;

    // Requests the person got from people who fit a playbook well: theirs to confirm (decision 30). The rest lately are
    // theirs to decide, in Waiting for you.
    for (const { p, fit } of await requestsToConfirm(ctx, me, playbooks))
      items.push(
        item({
          kind: 'confirm',
          name: p.name,
          profileId: p.id,
          profileUrl: p.url,
          why: ['Asked to be your friend', ...fit.reasons],
          playbookName: fit.playbookName,
        }),
      );

    // Warm leads (decision 50): people who reacted to or commented on the person's helpful posts lately. A comment
    // waits for an answer; someone not a friend yet goes first for a like back, then a friend request, as anyone does.
    const warm = await rows<{
      id: string;
      name: string;
      url: string;
      friendship: string;
      kind: 'comment' | 'reaction';
      comment: string | null;
      post_url: string | null;
      group_name: string | null;
      playbook_name: string | null;
      liked_at: Date | string | null;
      warm_up_missed_at: Date | string | null;
      reached: boolean;
      answered: boolean;
    }>(
      ctx.tx,
      sql`select distinct on (e.profile_id, e.kind) p.id, p.name, p.url, p.friendship, e.kind, e.comment,
            h.post_url, g.name as group_name, pb.name as playbook_name, p.warm_up_missed_at,
            (select max(t.at) from addon_outreach.touches t
              where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'like'
                and t.at >= ${ago(WARM_UP_WINDOW_DAYS)}::timestamptz) as liked_at,
            (exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.kind = 'friend_request')
              or exists (select 1 from addon_outreach.friends f
                where f.profile_id = p.id and f.user_id = ${me})) as reached,
            exists (select 1 from addon_outreach.touches t
              where t.user_id = ${me} and t.kind = 'comment' and h.post_url is not null
                and t.post_url = h.post_url and t.at >= e.seen_at) as answered
          from addon_outreach.engagements e
          join addon_outreach.profiles p on p.id = e.profile_id
          join addon_outreach.helpful h on h.id = e.helpful_id
          join addon_outreach.groups g on g.id = h.group_id
          left join addon_outreach.playbooks pb on pb.id = h.playbook_id
          where e.workspace_id = ${ws} and e.user_id = ${me}
            and e.seen_at >= ${ago(WARM_LEAD_DAYS)}::timestamptz
            and p.friendship <> 'self' and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
            and not exists (select 1 from addon_outreach.group_people x
              where x.profile_id = p.id and x.runs_group)
          order by e.profile_id, e.kind, e.seen_at desc`,
    );
    const did = (w: (typeof warm)[number]) =>
      `${w.kind === 'comment' ? 'Commented on' : 'Reacted to'} your post${w.group_name ? ` in ${w.group_name}` : ''}`;
    const answers = warm
      .filter((w) => w.kind === 'comment' && w.comment && !w.answered)
      .slice(0, leftToday(limits, 'warm_lead'));
    for (const w of answers)
      items.push(
        item({
          kind: 'warm_lead',
          name: w.name,
          profileId: w.id,
          profileUrl: w.url,
          postUrl: w.post_url,
          post:
            w.comment!.length > TODAY_POST_MOST
              ? `${w.comment!.slice(0, TODAY_POST_MOST - 1).trimEnd()}…`
              : w.comment,
          why: [did(w)],
          playbookName: w.playbook_name,
        }),
      );
    // Each person once, the comment over the reaction (comments come first).
    const once = new Map<string, (typeof warm)[number]>();
    for (const w of warm) if (!once.has(w.id)) once.set(w.id, w);
    const toFriend = [...once.values()].filter(
      (w) => !w.reached && !['friends', 'request_sent', 'request_received'].includes(w.friendship),
    );
    const warmIds = new Set(toFriend.map((w) => w.id));
    let warmRequests = 0;
    let warmLikes = 0;
    if (!requestsOff)
      for (const w of toFriend) {
        const liked = w.liked_at === null ? null : new Date(w.liked_at).getTime();
        const ready =
          !settings.warmUp ||
          w.warm_up_missed_at !== null ||
          (liked !== null && liked <= now - WARM_UP_WAIT_HOURS * HOUR);
        if (ready && warmRequests < leftToday(limits, 'friend_request')) {
          warmRequests++;
          items.push(
            item({
              kind: 'friend_request',
              name: w.name,
              profileId: w.id,
              profileUrl: w.url,
              why: [did(w), ...(liked !== null ? ['You liked a post of theirs back'] : [])],
              playbookName: w.playbook_name,
            }),
          );
        } else if (!ready && liked === null && warmLikes < leftToday(limits, 'warm_up')) {
          warmLikes++;
          items.push(
            item({
              kind: 'warm_up',
              name: w.name,
              profileId: w.id,
              profileUrl: w.url,
              why: [did(w), 'Like one of theirs back: their friend request comes a day after'],
              playbookName: w.playbook_name,
            }),
          );
        }
      }

    // Friend requests: people found in the groups, the best fit first. With Like a post first on (decision 33),
    // someone's request waits a day after one of their posts was liked, and the list has likes for tomorrow's.
    const requestsLeft = Math.max(0, leftToday(limits, 'friend_request') - warmRequests);
    const likesLeft = Math.max(0, leftToday(limits, 'warm_up') - warmLikes);
    if (playbooks.length && !requestsOff && (requestsLeft || (settings.warmUp && likesLeft))) {
      const found = await rows<{
        id: string;
        name: string;
        url: string;
        intro: string[];
        mutual_friends: number | null;
        lines: string[];
        group_id: string;
        group_name: string | null;
        group_detail: string | null;
        group_members: number | null;
        group_privacy: 'public' | 'private' | null;
        check_state: GroupCheckState | null;
        check_why: string[];
        check_playbook_id: string | null;
        in_group: boolean;
        liked_at: Date | string | null;
        warm_up_missed_at: Date | string | null;
      }>(
        ctx.tx,
        sql`select distinct on (p.id) p.id, p.name, p.url, p.intro, p.mutual_friends, gp.lines,
              gp.group_id, g.name as group_name, g.detail as group_detail, g.members as group_members,
              g.privacy as group_privacy, p.warm_up_missed_at, g.check_state, g.check_why, g.check_playbook_id,
              exists (select 1 from addon_outreach.my_groups m
                where m.group_id = g.id and m.user_id = ${me} and m.joined) as in_group,
              (select max(t.at) from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'like'
                  and t.at >= ${ago(WARM_UP_WINDOW_DAYS)}::timestamptz) as liked_at
            from addon_outreach.group_people gp
            join addon_outreach.groups g on g.id = gp.group_id
            join addon_outreach.profiles p on p.id = gp.profile_id
            where gp.workspace_id = ${ws} and g.admins_read_at is not null and not gp.runs_group
              and p.person_id is null and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
              and p.friendship not in ('self', 'friends', 'request_sent', 'request_received')
              and not exists (select 1 from addon_outreach.group_people x
                where x.profile_id = p.id and x.runs_group)
              and not exists (select 1 from addon_outreach.friends f
                where f.profile_id = p.id and f.user_id = ${me})
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.kind = 'friend_request')
            order by p.id, gp.seen_at desc
            limit ${CANDIDATES_MOST}`,
      );
      const fitted = found.flatMap((p) => {
        // A warm lead is on the list already, ahead of these.
        if (warmIds.has(p.id)) return [];
        // The AI's read of the group goes over its name (decision 48).
        const group = groupFitOf(playbooks, {
          name: p.group_name,
          detail: p.group_detail,
          members: p.group_members,
          privacy: p.group_privacy,
          joined: p.in_group,
          check_state: p.check_state,
          check_why: p.check_why,
          check_playbook_id: p.check_playbook_id,
          check_playbook: null,
        });
        if (group.verdict === 'skip') return [];
        const fit = bestFit(playbooks, {
          lines: [...p.lines, ...p.intro],
          mutualFriends: p.mutual_friends,
          groupName: p.group_name,
        });
        return fit.level === 'skip' || fit.level === 'unknown' ? [] : [{ p, fit }];
      });
      // Someone from a group whose people wrote back or booked demos comes ahead of others who fit as well (9a);
      // and the person's own groups, and those the AI says their people are in, before the rest (decision 48).
      const results = found.length
        ? resultsByGroup(await reachedPeople(ctx, { from: EVER, me, everyone: true }))
        : new Map<string, GroupResults>();
      const lift = (p: (typeof found)[number]) => {
        const r = results.get(p.group_id);
        return (
          (!r ? 0 : r.demos ? 2 : r.replies ? 1 : 0) +
          (p.in_group ? 1 : 0) +
          (p.check_state === 'good' ? 1 : 0)
        );
      };
      fitted.sort(
        (a, b) =>
          b.fit.score + lift(b.p) - (a.fit.score + lift(a.p)) || a.p.name.localeCompare(b.p.name),
      );
      const fromResults = (groupId: string) => {
        const r = results.get(groupId);
        return r?.demos
          ? ['Their group has brought demos']
          : r?.replies
            ? ['People from their group write back']
            : [];
      };
      const likedBy = (p: (typeof found)[number]) =>
        p.liked_at === null ? null : new Date(p.liked_at).getTime();
      const warmed = settings.warmUp
        ? fitted.filter(({ p }) => {
            const liked = likedBy(p);
            return (
              p.warm_up_missed_at !== null ||
              (liked !== null && liked <= now - WARM_UP_WAIT_HOURS * HOUR)
            );
          })
        : fitted;
      for (const { p, fit } of warmed.slice(0, requestsLeft))
        items.push(
          item({
            kind: 'friend_request',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [
              ...fit.reasons,
              ...fromResults(p.group_id),
              ...(settings.warmUp && likedBy(p) !== null ? ['You liked a post of theirs'] : []),
            ],
            playbookName: fit.playbookName,
          }),
        );
      if (settings.warmUp) {
        // Enough warmed up for a day's requests: those waiting, and those liked lately, count.
        const waiting = fitted.filter(
          ({ p }) => likedBy(p) !== null && p.warm_up_missed_at === null,
        );
        const wanted = Math.max(0, limits.friend_request.most - waiting.length - warmLikes);
        const cold = fitted.filter(({ p }) => likedBy(p) === null && p.warm_up_missed_at === null);
        for (const { p, fit } of cold.slice(0, Math.min(likesLeft, wanted)))
          items.push(
            item({
              kind: 'warm_up',
              name: p.name,
              profileId: p.id,
              profileUrl: p.url,
              why: [...fit.reasons, 'Their friend request comes a day after'],
              playbookName: fit.playbookName,
            }),
          );
      }
    }

    // Say hi: new friends who accepted the person's request, without a message yet.
    const openersLeft = leftToday(limits, 'opener');
    if (openersLeft) {
      const accepted = await rows<{ id: string; name: string; url: string; since: Date | string }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, f.since from addon_outreach.friends f
            join addon_outreach.profiles p on p.id = f.profile_id
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.state = 'friends'
              and f.since between ${ago(TODAY_WINDOW_DAYS.opener)}::timestamptz
                and ${ago(pace.messageAfterDays)}::timestamptz
              and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
              and exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.user_id = ${me} and t.kind = 'friend_request')
              and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.kind = 'message')
              and not exists (select 1 from addon_outreach.file_chats c where c.profile_id = p.id
                and c.user_id = ${me})
            order by f.since desc limit ${openersLeft}`,
      );
      for (const p of accepted)
        items.push(
          item({
            kind: 'opener',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [`Accepted your request ${dayWords(p.since, now)}`],
            demoLink: demoFor(p.id),
          }),
        );
    }

    // Pitch (decision 47): people whose chat the AI read as ready for the offer, or the person marked ready, until a
    // pitch goes, they're booked or not a fit, or the person writes to them again. They count against the follow-ups.
    const pitchLeft = leftToday(limits, 'pitch');
    if (pitchLeft) {
      const ready = await rows<{
        id: string;
        name: string;
        url: string;
        chat_id: string | null;
        thread_key: string | null;
        summary: string | null;
        next_step: string | null;
        pitch_why: string | null;
        marked: boolean;
      }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, c.id as chat_id, c.thread_key, c.summary, c.next_step, c.pitch_why,
              coalesce(s.mark = 'ready', false) as marked
            from addon_outreach.profiles p
            left join addon_outreach.stages s on s.profile_id = p.id and s.user_id = ${me}
            left join lateral (
              select c.id, c.thread_key, c.summary, c.next_step, c.pitch, c.pitch_why, c.last_at
              from addon_outreach.file_chats c where c.profile_id = p.id and c.user_id = ${me}
              order by c.last_at desc limit 1
            ) c on true
            where p.workspace_id = ${ws} and p.friendship <> 'self' and ${pitchable('p')} and ${lets}
              and (c.pitch = 'ready' or s.mark = 'ready')
              and (s.id is null or (s.pitched_at is null and s.mark is distinct from 'lost'))
              and not exists (select 1 from addon_outreach.demos d
                where d.profile_id = p.id and d.user_id = ${me} and d.undone_at is null)
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'message'
                  and t.at > greatest(c.last_at, s.marked_at))
            order by greatest(c.last_at, s.marked_at) desc nulls last, p.id
            limit ${pitchLeft}`,
      );
      for (const p of ready)
        items.push(
          item({
            kind: 'pitch',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            chatId: p.chat_id,
            threadKey: p.thread_key,
            why: [p.marked ? 'You marked them ready' : (p.pitch_why ?? 'Ready for your offer')],
            summary: p.summary,
            nextStep: p.next_step,
            demoLink: demoFor(p.id),
          }),
        );
    }
    const pitching = new Set(items.filter((i) => i.kind === 'pitch').map((i) => i.profileId));

    // Follow-ups and replies: likely prospects in the person's chats.
    const chats = await rows<{
      id: string;
      name: string;
      profile_id: string | null;
      url: string | null;
      thread_key: string | null;
      last_at: Date | string;
      last_from_me: boolean;
      summary: string | null;
      next_step: string | null;
    }>(
      ctx.tx,
      sql`select c.id, c.name, c.profile_id, p.url, c.thread_key, c.last_at, c.last_from_me, c.summary,
            c.next_step
          from addon_outreach.file_chats c left join addon_outreach.profiles p on p.id = c.profile_id
          where c.workspace_id = ${ws} and c.user_id = ${me} and c.read_state = 'read' and c.prospect
            and (p.id is null or (${pitchable('p')} and ${inPlay(me, 'p')}
              and (not c.last_from_me or ${lets})))
            and ((c.last_from_me and c.last_at between ${ago(TODAY_WINDOW_DAYS.follow_up)}::timestamptz
                  and ${ago(pace.followUpAfterDays)}::timestamptz)
              or (not c.last_from_me and c.last_at >= ${ago(TODAY_WINDOW_DAYS.reply)}::timestamptz))
            and not exists (select 1 from addon_outreach.touches t
              where t.profile_id = c.profile_id and t.user_id = ${me} and t.kind = 'message'
                and t.at > c.last_at)
          order by c.last_at desc limit ${TODAY_MOST * 2}`,
    );
    let followUps = leftToday(limits, 'follow_up') - pitching.size;
    let replies = TODAY_MOST;
    for (const c of chats) {
      // Someone to pitch is on the list for that: the pitch answers where the chat left off.
      if (c.profile_id && pitching.has(c.profile_id)) continue;
      const kind = c.last_from_me ? 'follow_up' : 'reply';
      if (kind === 'follow_up' ? followUps-- <= 0 : replies-- <= 0) continue;
      items.push(
        item({
          kind,
          name: c.name,
          profileId: c.profile_id,
          profileUrl: c.url,
          chatId: c.id,
          threadKey: c.thread_key,
          why: [
            kind === 'reply'
              ? `They wrote ${dayWords(c.last_at, now)}`
              : `You wrote last, ${dayWords(c.last_at, now)}`,
          ],
          summary: c.summary,
          nextStep: c.next_step,
          demoLink: demoFor(c.profile_id),
        }),
      );
    }

    // Replies the extension saw (decision 22), for anyone not listed from their chat already, until the person
    // writes back.
    const listed = new Set(items.map((i) => i.profileId).filter(Boolean));
    const seen = await rows<{
      profile_id: string;
      name: string;
      url: string;
      thread_key: string | null;
      seen_at: Date | string;
    }>(
      ctx.tx,
      sql`select distinct on (r.profile_id) r.profile_id, p.name, p.url, r.thread_key, r.seen_at
          from addon_outreach.replies r join addon_outreach.profiles p on p.id = r.profile_id
          where r.workspace_id = ${ws} and r.user_id = ${me}
            and r.seen_at >= ${ago(TODAY_WINDOW_DAYS.reply)}::timestamptz and ${pitchable('p')}
            and not exists (select 1 from addon_outreach.touches t
              where t.profile_id = r.profile_id and t.user_id = ${me} and t.kind = 'message'
                and t.at > r.seen_at)
          order by r.profile_id, r.seen_at desc`,
    );
    seen.sort((a, b) => new Date(b.seen_at).getTime() - new Date(a.seen_at).getTime());
    for (const r of seen) {
      if (listed.has(r.profile_id) || replies-- <= 0) continue;
      items.push(
        item({
          kind: 'reply',
          name: r.name,
          profileId: r.profile_id,
          profileUrl: r.url,
          threadKey: r.thread_key,
          why: [`Wrote back ${dayWords(r.seen_at, now)}`],
          demoLink: demoFor(r.profile_id),
        }),
      );
    }

    // Reconnect (decision 46): friends and people they've chatted with whom the AI found a good fit, once neither
    // side has written for a month, and not on the list already. They share the first messages' limit with Say hi.
    const reconnectLeft = Math.max(
      0,
      leftToday(limits, 'reconnect') - items.filter((i) => i.kind === 'opener').length,
    );
    if (reconnectLeft) {
      const quiet = ago(RECONNECT_QUIET_DAYS);
      const fits = await rows<{
        id: string;
        name: string;
        url: string;
        why: string[];
        about: string | null;
        next_step: string | null;
        playbook_name: string | null;
        chat_id: string | null;
        thread_key: string | null;
      }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, ch.why, ch.about, ch.next_step, pb.name as playbook_name,
              c.id as chat_id, c.thread_key
            from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            left join addon_outreach.playbooks pb on pb.id = ch.playbook_id
            left join lateral (
              select c.id, c.thread_key, c.last_at from addon_outreach.file_chats c
              where c.profile_id = p.id and c.user_id = ${me} order by c.last_at desc limit 1
            ) c on true
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and ch.verdict = 'good'
              and p.friendship <> 'self' and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
              and (c.last_at is null or c.last_at < ${quiet}::timestamptz)
              and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.user_id = ${me} and t.kind = 'message' and t.at >= ${quiet}::timestamptz)
              and not exists (select 1 from addon_outreach.replies r where r.profile_id = p.id
                and r.user_id = ${me} and r.seen_at >= ${quiet}::timestamptz)
            order by ch.checked_at desc, p.id limit ${reconnectLeft + items.length}`,
      );
      const listedNow = new Set(items.map((i) => i.profileId).filter(Boolean));
      for (const p of fits.filter((f) => !listedNow.has(f.id)).slice(0, reconnectLeft))
        items.push(
          item({
            kind: 'reconnect',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            chatId: p.chat_id,
            threadKey: p.thread_key,
            why: p.why,
            summary: p.about,
            nextStep: p.next_step,
            playbookName: p.playbook_name,
            demoLink: demoFor(p.id),
          }),
        );
    }

    // Comments: posts in the groups the AI checked as good, from the last week: those asking for what the business
    // offers first (decision 49), then the newest.
    const commentsLeft = Math.max(0, leftToday(limits, 'comment') - answers.length);
    if (commentsLeft) {
      const good = await rows<{
        id: string;
        url: string;
        posted: string | null;
        body: string;
        check_why: string | null;
        profile_id: string;
        name: string;
        profile_url: string;
        group_name: string | null;
        playbook_name: string | null;
        strong: boolean;
      }>(
        ctx.tx,
        sql`select po.id, po.url, po.posted, po.body, po.check_why, po.strong, p.id as profile_id, p.name,
              p.url as profile_url, g.name as group_name, pb.name as playbook_name
            from addon_outreach.posts po
            join addon_outreach.profiles p on p.id = po.profile_id
            left join addon_outreach.groups g on g.id = po.group_id
            left join addon_outreach.playbooks pb on pb.id = po.playbook_id
            where po.workspace_id = ${ws} and po.user_id = ${me} and po.check_state = 'good'
              and po.skipped_at is null and po.seen_at >= ${ago(POST_FRESH_DAYS)}::timestamptz
              and p.friendship <> 'self' and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
              and not exists (select 1 from addon_outreach.group_people x
                where x.profile_id = p.id and x.runs_group)
              and not exists (select 1 from addon_outreach.touches t
                where t.user_id = ${me} and t.kind = 'comment' and t.post_url = po.url)
            order by po.strong desc, po.seen_at desc limit ${commentsLeft}`,
      );
      for (const po of good)
        items.push(
          item({
            kind: 'comment',
            name: po.name,
            profileId: po.profile_id,
            profileUrl: po.profile_url,
            postId: po.id,
            postUrl: po.url,
            posted: po.posted,
            post:
              po.body.length > TODAY_POST_MOST
                ? `${po.body.slice(0, TODAY_POST_MOST - 1).trimEnd()}…`
                : po.body,
            asking: po.strong,
            why: [
              ...(po.check_why ? [po.check_why] : []),
              ...(po.group_name ? [`In ${po.group_name}`] : []),
            ],
            playbookName: po.playbook_name,
          }),
        );
    }

    const readAdmins = await rows<{ id: string; name: string | null; url: string }>(
      ctx.tx,
      sql`select g.id, g.name, g.url from addon_outreach.groups g
          where g.workspace_id = ${ws} and g.admins_read_at is null
            and exists (select 1 from addon_outreach.group_people gp
              where gp.group_id = g.id and not gp.runs_group)
          order by g.seen_at desc nulls last limit 10`,
    );
    // The messages the extension drafted (../sends.ts): each with its item, and anyone skipped today off the list.
    const drafted = await sendsToday(ctx, me, todayFrom);
    // Who's in Contacts already, and who the person marked as having booked a demo: the web's menu on each.
    const profileIds = [...new Set(items.map((i) => i.profileId).filter((id) => id !== null))];
    const known = profileIds.length
      ? await rows<{ id: string; person_id: string | null; marked: boolean }>(
          ctx.tx,
          sql`select p.id, p.person_id, exists (select 1 from addon_outreach.demos d
                where d.profile_id = p.id and d.user_id = ${me} and d.how = 'marked' and d.undone_at is null) as marked
              from addon_outreach.profiles p
              where p.workspace_id = ${ws} and p.id = any (${`{${profileIds.join(',')}}`}::uuid[])`,
        )
      : [];
    const knownOf = new Map(known.map((k) => [k.id, k]));
    // A message's chat, where it's going, to see beside it.
    const isMessage = (i: TodayItem) => (MESSAGE_KINDS as readonly string[]).includes(i.kind);
    const recent = await recentOf(ctx, me, items.filter(isMessage));
    // A post asking for what the business offers tops the list (decision 49): answered fast, before anything else.
    const listedItems = [...items.filter((i) => i.asking), ...items.filter((i) => !i.asking)]
      .filter((i) => !drafted.off(i.profileId, i.kind))
      .map((i) => {
        const send = drafted.open(i.profileId, i.kind);
        const k = i.profileId ? knownOf.get(i.profileId) : undefined;
        return {
          ...i,
          personId: k?.person_id ?? null,
          demoBooked: k?.marked ?? false,
          recent: isMessage(i) ? (recent.get(chatKey(i)) ?? []) : [],
          ...(send ? { send } : {}),
        };
      });
    return {
      limits,
      items: ready ? listedItems : listedItems.filter((i) => i.kind === 'reply'),
      readAdmins: readAdmins.map((g) => ({ groupId: g.id, name: g.name, url: g.url })),
      hasPlaybook: playbooks.length > 0,
      warning,
      auto: ready ? autoKinds(settings) : [],
      messages: messageKinds(settings).filter((k) => ready || k === 'reply'),
      sending: settings.sending,
      wheels,
      ready,
    };
  },
});

/** "today", "yesterday", "4 days ago". */
function dayWords(at: Date | string, now: number): string {
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

export const todayQueries = [today] as const;
