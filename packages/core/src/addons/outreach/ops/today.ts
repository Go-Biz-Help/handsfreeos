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
import { WARM_UP_WAIT_HOURS, WARM_UP_WINDOW_DAYS, autoKinds, messageKinds } from '../automation';
import { demoLink, demoRef } from '../demos';
import { bestFit } from '../fit';
import { bestGroupFit } from '../groups';
import { dailyLimitsNow, DONT_PITCH_TAG } from '../limits';
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
import type { GroupResults } from '../results';
import { EVER, reachedPeople, resultsByGroup } from './activity';
import { automationOf } from './automation';
import { inWorkspace } from './common';
import { playbooksInUse } from './friends';
import { sendsToday } from './sends';
import { slowsNow, startOfToday, warningOf } from './tidy';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The most people from groups weighed for requests at once. */
const CANDIDATES_MOST = 500;

/** A profile that's never pitched: on Don't pitch, or a customer tagged Friend or family. */
const pitchable = (p: string) => sql`not ${sql.raw(p)}.dont_pitch and not exists (
  select 1 from app.record_tags rt join app.tags tg on tg.id = rt.tag_id
  where rt.record_type = 'person' and rt.record_id = ${sql.raw(p)}.person_id
    and lower(tg.name::text) = lower(${DONT_PITCH_TAG}))`;

export const today = defineAddonQuery(outreachAddon, {
  name: 'outreach.today',
  description:
    'The person’s list for today on Facebook, for them or the extension to do: requests they got from people who fit a playbook to confirm, posts to like before a friend request, friend requests to people found in the business’s groups who fit a playbook (never anyone who runs a group, is on Don’t pitch or is in Contacts), a first message to new friends who accepted, follow-ups to likely prospects gone quiet, replies owed and posts to comment on; with today’s steps against the daily limits.',
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
    const [done] = await rows<{
      friend_request: number;
      first_message: number;
      follow_up: number;
      comment: number;
      like: number;
    }>(
      ctx.tx,
      sql`select count(*) filter (where kind = 'friend_request')::int as friend_request,
            count(*) filter (where step = 'first_message')::int as first_message,
            count(*) filter (where step = 'follow_up')::int as follow_up,
            count(*) filter (where kind = 'comment')::int as comment,
            count(*) filter (where kind = 'like')::int as "like"
          from addon_outreach.touches
          where workspace_id = ${ws} and user_id = ${me} and at >= ${todayFrom}::timestamptz`,
    );
    const { settings, wheels } = await automationOf(ctx, me, now);
    // Halved after a warning from Facebook, and on training wheels.
    const limits = todayLimits(
      done ?? { friend_request: 0, first_message: 0, follow_up: 0, comment: 0, like: 0 },
      dailyLimitsNow(slowsNow(warning, now) || wheels.on),
    );
    const requestsOff = warning !== null && new Date(warning.requestsFrom).getTime() > now;
    const playbooks = await playbooksInUse(ctx);
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
      why: [],
      summary: null,
      nextStep: null,
      playbookName: null,
      demoLink: null,
      send: null,
      ...more,
    });
    // The demo link for a message (decision 24): the first playbook in use with a link, by name.
    const linked = [...playbooks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((p) => p.details.link);
    const demoFor = (profileId: string | null) =>
      linked && profileId ? demoLink(linked.details.link, demoRef(me, profileId)) : null;

    // Requests the person got from people who fit a playbook well: theirs to confirm (decision 30).
    if (playbooks.length) {
      const asked = await rows<{
        id: string;
        name: string;
        url: string;
        intro: string[];
        mutual_friends: number | null;
        group_name: string | null;
      }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, p.intro, p.mutual_friends, g.name as group_name
            from addon_outreach.friends f
            join addon_outreach.profiles p on p.id = f.profile_id
            left join addon_outreach.groups g on g.id = p.group_id
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.state = 'request_received'
              and ${pitchable('p')}
            order by f.since desc limit ${CANDIDATES_MOST}`,
      );
      const good = asked
        .map((p) => ({
          p,
          fit: bestFit(playbooks, {
            lines: p.intro,
            mutualFriends: p.mutual_friends,
            groupName: p.group_name,
          }),
        }))
        .filter(({ fit }) => fit.level === 'good')
        .sort((a, b) => b.fit.score - a.fit.score || a.p.name.localeCompare(b.p.name));
      for (const { p, fit } of good.slice(0, TODAY_MOST))
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
    }

    // Friend requests: people found in the groups, the best fit first. With Like a post first on (decision 33),
    // someone's request waits a day after one of their posts was liked, and the list has likes for tomorrow's.
    const requestsLeft = leftToday(limits, 'friend_request');
    const likesLeft = leftToday(limits, 'warm_up');
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
        liked_at: Date | string | null;
        warm_up_missed_at: Date | string | null;
      }>(
        ctx.tx,
        sql`select distinct on (p.id) p.id, p.name, p.url, p.intro, p.mutual_friends, gp.lines,
              gp.group_id, g.name as group_name, g.detail as group_detail, g.members as group_members,
              g.privacy as group_privacy, p.warm_up_missed_at,
              (select max(t.at) from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'like'
                  and t.at >= ${ago(WARM_UP_WINDOW_DAYS)}::timestamptz) as liked_at
            from addon_outreach.group_people gp
            join addon_outreach.groups g on g.id = gp.group_id
            join addon_outreach.profiles p on p.id = gp.profile_id
            where gp.workspace_id = ${ws} and g.admins_read_at is not null and not gp.runs_group
              and p.person_id is null and ${pitchable('p')}
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
        const group = bestGroupFit(playbooks, {
          name: p.group_name,
          detail: p.group_detail,
          members: p.group_members,
          privacy: p.group_privacy,
          joined: null,
        });
        if (group.verdict === 'skip') return [];
        const fit = bestFit(playbooks, {
          lines: [...p.lines, ...p.intro],
          mutualFriends: p.mutual_friends,
          groupName: p.group_name,
        });
        return fit.level === 'skip' || fit.level === 'unknown' ? [] : [{ p, fit }];
      });
      // Someone from a group whose people wrote back or booked demos comes ahead of others who fit as well (9a).
      const results = found.length
        ? resultsByGroup(await reachedPeople(ctx, { from: EVER, me, everyone: true }))
        : new Map<string, GroupResults>();
      const lift = (groupId: string) => {
        const r = results.get(groupId);
        return !r ? 0 : r.demos ? 2 : r.replies ? 1 : 0;
      };
      fitted.sort(
        (a, b) =>
          b.fit.score + lift(b.p.group_id) - (a.fit.score + lift(a.p.group_id)) ||
          a.p.name.localeCompare(b.p.name),
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
        const wanted = Math.max(0, limits.friend_request.most - waiting.length);
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
              and ${pitchable('p')}
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
            and (p.id is null or ${pitchable('p')})
            and ((c.last_from_me and c.last_at between ${ago(TODAY_WINDOW_DAYS.follow_up)}::timestamptz
                  and ${ago(pace.followUpAfterDays)}::timestamptz)
              or (not c.last_from_me and c.last_at >= ${ago(TODAY_WINDOW_DAYS.reply)}::timestamptz))
            and not exists (select 1 from addon_outreach.touches t
              where t.profile_id = c.profile_id and t.user_id = ${me} and t.kind = 'message'
                and t.at > c.last_at)
          order by c.last_at desc limit ${TODAY_MOST * 2}`,
    );
    let followUps = leftToday(limits, 'follow_up');
    let replies = TODAY_MOST;
    for (const c of chats) {
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

    // Comments: posts in the groups the AI checked as good, from the last week, the newest first.
    const commentsLeft = leftToday(limits, 'comment');
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
      }>(
        ctx.tx,
        sql`select po.id, po.url, po.posted, po.body, po.check_why, p.id as profile_id, p.name,
              p.url as profile_url, g.name as group_name, pb.name as playbook_name
            from addon_outreach.posts po
            join addon_outreach.profiles p on p.id = po.profile_id
            left join addon_outreach.groups g on g.id = po.group_id
            left join addon_outreach.playbooks pb on pb.id = po.playbook_id
            where po.workspace_id = ${ws} and po.user_id = ${me} and po.check_state = 'good'
              and po.skipped_at is null and po.seen_at >= ${ago(POST_FRESH_DAYS)}::timestamptz
              and p.friendship <> 'self' and ${pitchable('p')}
              and not exists (select 1 from addon_outreach.group_people x
                where x.profile_id = p.id and x.runs_group)
              and not exists (select 1 from addon_outreach.touches t
                where t.user_id = ${me} and t.kind = 'comment' and t.post_url = po.url)
            order by po.seen_at desc limit ${commentsLeft}`,
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
    const listedItems = items
      .filter((i) => !drafted.off(i.profileId, i.kind))
      .map((i) => {
        const send = drafted.open(i.profileId, i.kind);
        return send ? { ...i, send } : i;
      });
    return {
      limits,
      items: listedItems,
      readAdmins: readAdmins.map((g) => ({ groupId: g.id, name: g.name, url: g.url })),
      hasPlaybook: playbooks.length > 0,
      warning,
      auto: autoKinds(settings),
      messages: messageKinds(settings),
      sending: settings.sending,
      wheels,
    };
  },
});

/** "today", "yesterday", "4 days ago". */
function dayWords(at: Date | string, now: number): string {
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

export const todayQueries = [today] as const;
