/**
 * Today (../today.ts): the person's list for the day on Facebook, worked out each time it's asked for from the
 * groups, friends, chats and steps HandsFreeOS keeps. Nothing is saved: a step the person takes is noted by the
 * extension, and that takes it off the list.
 */
import { sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { workspaceTimezone } from '../../../crm/records';
import { intlTimeZone } from '../../../intl/engine-zones';
import { userIdOf } from '../../../kernel/actor';
import { defineAddonQuery } from '../../server';
import {
  MESSAGE_KINDS,
  WARM_UP_WAIT_HOURS,
  WARM_UP_WINDOW_DAYS,
  autoKinds,
  businessLimitsOn,
  messageKinds,
} from '../automation';
import { demoLink, demoRef } from '../demos';
import { bestFit, type Fit, type FitPlaybook } from '../fit';
import type { GroupCheckState } from '../group-checks';
import { type DailyStep } from '../limits';
import { inNetworkWords, networkLimitsNow, NETWORKS } from '../networks';
import { outreachAddon } from '../manifest';
import {
  ANSWERS,
  CONVERSATION_STEPS,
  type Answer,
  type ConversationStep,
  type FollowUpNext,
} from '../conversation';
import { paceOf, type Platform } from '../playbooks';
import {
  leftToday,
  RECOMMEND_PER_DAY,
  RECOMMEND_WORDS,
  REQUESTS_WHY,
  TODAY_KIND_KEYS,
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
import { conversationPace } from './conversation';
import { partnerRoom, partnerToday } from './partners';
import {
  chatKey,
  countryLetsSql,
  countryRuleOf,
  inPlay,
  inWorkspace,
  notNever,
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
/** A message the person wrote to someone themselves this lately puts their next follow-up off. */
const MANUAL_QUIET_HOURS = 20;

const NONE_DONE: Record<DailyStep, number> = {
  friend_request: 0,
  first_message: 0,
  follow_up: 0,
  comment: 0,
  like: 0,
};

/**
 * Each person's steps on a network since the start of today that count against its daily limits, as Today counts
 * them; the live view (./live.ts) counts with it too, so the two never disagree. Each network counts only its own
 * steps, against its own limits.
 */
export async function dayCounts(
  ctx: Ctx,
  userIds: readonly string[],
  platform: Platform,
  todayFrom: Date,
): Promise<Map<string, Record<DailyStep, number>>> {
  const counted = new Map(userIds.map((id) => [id, { ...NONE_DONE }]));
  if (!userIds.length) return counted;
  const found = await rows<{ user_id: string } & Record<DailyStep, number>>(
    ctx.tx,
    sql`select t.user_id, count(*) filter (where t.kind = 'friend_request')::int as friend_request,
          count(*) filter (where t.step = 'first_message')::int as first_message,
          count(*) filter (where t.step = 'follow_up')::int as follow_up,
          count(*) filter (where t.kind = 'comment')::int as comment,
          count(*) filter (where t.kind = 'like')::int as "like"
        from addon_outreach.touches t
        join addon_outreach.profiles p on p.id = t.profile_id
        where t.workspace_id = ${ctx.scope.workspaceId!} and p.platform = ${platform}
          and t.user_id = any (${`{${userIds.join(',')}}`}::uuid[])
          and t.at >= ${todayFrom.toISOString()}::timestamptz
        group by t.user_id`,
  );
  for (const { user_id, ...done } of found) counted.set(user_id, done);
  return counted;
}
/** The most people from groups weighed for requests at once. */
const CANDIDATES_MOST = 500;

export { notNever, pitchable };

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
 * person's to decide. A partner's is confirmed like anyone's (decision 81): saying yes to a request is no pitch.
 */
export async function requestsToConfirm(
  ctx: Ctx,
  me: string,
  playbooks: readonly FitPlaybook[],
  platform: Platform = 'facebook',
): Promise<{ readonly p: RequestGot; readonly fit: Fit }[]> {
  if (!playbooks.length) return [];
  // The business's country setting skips some (decision 61): they're on the Skipped for country list instead. Only
  // the network's own requests are its to confirm.
  const lets = sql`(${countryLetsSql(await countryRuleOf(ctx), 'p')} and p.platform = ${platform})`;
  const asked = await rows<RequestGot>(
    ctx.tx,
    sql`select p.id, p.name, p.url, p.intro, p.mutual_friends, g.name as group_name
        from addon_outreach.friends f
        join addon_outreach.profiles p on p.id = f.profile_id
        left join addon_outreach.groups g on g.id = p.group_id
        where f.workspace_id = ${ctx.scope.workspaceId!} and f.user_id = ${me}
          and f.state = 'request_received' and ${notNever('p')} and ${inPlay(me, 'p')} and ${lets}
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
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has a list for today.');
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const todayStart = await startOfToday(ctx, now);
    const todayFrom = todayStart.toISOString();
    // The network's own warning and steps: another network's never slow this one or use up its limits.
    const warning = await warningOf(ctx, me, input.platform, todayStart, now);
    const done = (await dayCounts(ctx, [me], input.platform, todayStart)).get(me)!;
    // The person's choices, training wheels and limits on this network: each network's are its own.
    const { choices: settings, wheels, rules } = await automationOf(ctx, me, now, input.platform);
    // The business's own on this network, halved after a warning there, and on training wheels there.
    const limits = todayLimits(
      done,
      networkLimitsNow(
        input.platform,
        slowsNow(warning, now) || wheels.on,
        businessLimitsOn(rules, input.platform),
      ),
    );
    // A network's cap on requests in any 7 days (LinkedIn's 80 invitations): today's limit never goes past what's left.
    const weekly = NETWORKS[input.platform].weeklyRequests;
    let week: { done: number; most: number } | null = null;
    if (weekly !== null) {
      const [sent] = await rows<{ n: number }>(
        ctx.tx,
        sql`select count(*)::int as n from addon_outreach.touches t
            join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.kind = 'friend_request'
              and p.platform = ${input.platform} and t.at >= ${new Date(now - 7 * DAY).toISOString()}::timestamptz`,
      );
      week = { done: sent?.n ?? 0, most: weekly };
      const r = limits.friend_request;
      r.most = Math.min(r.most, r.done + Math.max(0, weekly - week.done));
    }
    // Until they're ready (decision 63), the list keeps only replies owed to people who wrote to them, and nothing is
    // done on its own: Get ready shows in place of the rest.
    const ready = (await readinessFor(ctx, me, input.platform)).ready;
    const requestsOff = warning !== null && new Date(warning.requestsFrom).getTime() > now;
    const playbooks = await playbooksInUse(ctx, input.platform);
    // Who the business's country setting lets be reached (decision 61): everything new on the list but a reply owed.
    // Only this network's people: every list of the day is one network's (Chris: each network on its own).
    const lets = sql`(${countryLetsSql(await countryRuleOf(ctx), 'p')} and p.platform = ${input.platform})`;
    // The soonest any playbook in use goes: a first message so many days after they accept, and a follow-up in a chat
    // that started another way so many quiet days after the person wrote.
    const paces = (playbooks.length ? playbooks.map((p) => p.details.pace) : [null]).map(paceOf);
    const pace = {
      messageAfterDays: Math.min(...paces.map((p) => p.messageAfterDays)),
      firstGap: Math.min(...paces.map((p) => p.followUpGaps[0] ?? 1)),
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
      videoLink: null,
      send: null,
      personId: null,
      demoBooked: false,
      partnerId: null,
      requests: false,
      recent: [],
      ...more,
    });
    // The demo link for a message (decision 24): the first playbook in use with a link, by name.
    const linked = [...playbooks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((p) => p.details.link);
    const demoFor = (profileId: string | null) =>
      linked && profileId ? demoLink(linked.details.link, demoRef(me, profileId)) : null;
    // The short video for Send the video (decision 66): the first playbook in use with one, by name, likewise.
    const videoed = [...playbooks]
      .sort((a, b) => a.name.localeCompare(b.name))
      .find((p) => p.details.videoLink);
    const hasVideo = Boolean(videoed);

    // Requests the person got from people who fit a playbook well: theirs to confirm (decision 30). The rest lately are
    // theirs to decide, in Waiting for you.
    for (const { p, fit } of await requestsToConfirm(ctx, me, playbooks, input.platform))
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
      kind: 'comment' | 'reaction' | 'recommend';
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
          left join addon_outreach.helpful h on h.id = e.helpful_id
          left join addon_outreach.groups g on g.id = h.group_id
          left join addon_outreach.playbooks pb on pb.id = h.playbook_id
          where e.workspace_id = ${ws} and e.user_id = ${me}
            and e.seen_at >= ${ago(WARM_LEAD_DAYS)}::timestamptz
            and p.friendship <> 'self' and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
            and not exists (select 1 from addon_outreach.group_people x
              where x.profile_id = p.id and x.runs_group)
          order by e.profile_id, e.kind, e.seen_at desc`,
    );
    // Where the post is: its group on Facebook, and the person's own feed elsewhere ("on LinkedIn"). Off any helpful
    // post, the network's own notifications said it (Alignable's): a recommendation, or their post or answer liked.
    const on = (w: (typeof warm)[number]) =>
      w.group_name
        ? ` in ${w.group_name}`
        : input.platform === 'facebook'
          ? ''
          : ` on ${NETWORKS[input.platform].name}`;
    const did = (w: (typeof warm)[number]) =>
      w.kind === 'recommend'
        ? `Recommended you${on(w)}`
        : `${w.kind === 'comment' ? 'Commented on' : 'Reacted to'} your post${on(w)}`;
    // Only a comment under a helpful post the extension can open again is answered there.
    const answers = warm
      .filter((w) => w.kind === 'comment' && w.comment && w.post_url && !w.answered)
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

    // People found by a search (the Instagram and Alignable plan's "people found by a search"): whoever wrote a post the
    // network's own search found, off any group, that the AI said was worth a comment. The comment, or a like, is their
    // warm-up: with Like a post first on, their request comes a day after it; before it, their post's comment is on the
    // list instead. Ahead of the groups' people, whom nothing has warmed yet.
    let searchRequests = 0;
    const searchLeft = Math.max(0, leftToday(limits, 'friend_request') - warmRequests);
    if (playbooks.length && !requestsOff && searchLeft) {
      const searched = await rows<{
        id: string;
        name: string;
        url: string;
        intro: string[];
        body: string;
        playbook_name: string | null;
        warmed_at: Date | string | null;
        warm_up_missed_at: Date | string | null;
      }>(
        ctx.tx,
        sql`select distinct on (p.id) p.id, p.name, p.url, p.intro, po.body, pb.name as playbook_name,
              p.warm_up_missed_at,
              (select max(t.at) from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind in ('like', 'comment')
                  and t.at >= ${ago(WARM_UP_WINDOW_DAYS)}::timestamptz) as warmed_at
            from addon_outreach.posts po
            join addon_outreach.profiles p on p.id = po.profile_id
            left join addon_outreach.playbooks pb on pb.id = po.playbook_id
            where po.workspace_id = ${ws} and po.group_id is null and po.check_state = 'good'
              and po.seen_at >= ${ago(WARM_UP_WINDOW_DAYS)}::timestamptz
              and p.person_id is null and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
              and p.friendship not in ('self', 'friends', 'request_sent', 'request_received')
              and not exists (select 1 from addon_outreach.group_people x
                where x.profile_id = p.id and x.runs_group)
              and not exists (select 1 from addon_outreach.friends f
                where f.profile_id = p.id and f.user_id = ${me})
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.kind = 'friend_request')
            order by p.id, po.seen_at desc
            limit ${CANDIDATES_MOST}`,
      );
      const ready = searched.flatMap((p) => {
        if (warmIds.has(p.id)) return [];
        const warmedAt = p.warmed_at === null ? null : new Date(p.warmed_at).getTime();
        if (
          settings.warmUp &&
          p.warm_up_missed_at === null &&
          (warmedAt === null || warmedAt > now - WARM_UP_WAIT_HOURS * HOUR)
        )
          return [];
        const fit = bestFit(playbooks, {
          lines: [p.body, ...p.intro],
          mutualFriends: null,
          groupName: null,
        });
        return fit.level === 'skip' ? [] : [{ p, fit, warmed: warmedAt !== null }];
      });
      ready.sort((a, b) => b.fit.score - a.fit.score || a.p.name.localeCompare(b.p.name));
      for (const { p, fit, warmed } of ready.slice(0, searchLeft)) {
        searchRequests++;
        warmIds.add(p.id);
        items.push(
          item({
            kind: 'friend_request',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [
              `Wrote a post your search on ${NETWORKS[input.platform].name} found`,
              ...fit.reasons,
              ...(warmed ? ['You commented on or liked their post'] : []),
            ],
            playbookName: fit.playbookName ?? p.playbook_name,
          }),
        );
      }
    }

    // Friend requests: people found in the groups, the best fit first. With Like a post first on (decision 33),
    // someone's request waits a day after one of their posts was liked, and the list has likes for tomorrow's.
    const requestsLeft = Math.max(
      0,
      leftToday(limits, 'friend_request') - warmRequests - searchRequests,
    );
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

    // First message (decision 65): new friends who accepted the person's request, without a message yet. On a follow
    // network (Instagram's) a follow-back is the accepting: someone they followed who's among their saved followers.
    const kit = NETWORKS[input.platform];
    const follows = kit.requestsMessageAfterDays !== null;
    const openersLeft = leftToday(limits, 'opener');
    let openers = 0;
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
              and not exists (select 1 from addon_outreach.follow_ups fu where fu.profile_id = p.id
                and fu.user_id = ${me})
            order by f.since desc limit ${openersLeft}`,
      );
      openers = accepted.length;
      for (const p of accepted)
        items.push(
          item({
            kind: 'opener',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [
              follows
                ? `Followed you back ${dayWords(p.since, now)}`
                : `Accepted your request ${dayWords(p.since, now)}`,
            ],
            demoLink: demoFor(p.id),
          }),
        );
    }

    // No follow-back in a few days, on a follow network (Instagram's, the Instagram and Alignable plan's "The steps"):
    // one short first message, which lands in their Requests. No link and no video, one text: Instagram passes only one
    // till they accept it. At most so many of the day's first messages go there, those sent there today counted.
    const requestsAfter = kit.requestsMessageAfterDays;
    const requestsCap = kit.requestsMessagesPerDay;
    if (requestsAfter !== null && requestsCap !== null && openersLeft > openers) {
      const [sentThere] = await rows<{ n: number }>(
        ctx.tx,
        sql`select count(*)::int as n from addon_outreach.touches t
            join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.step = 'first_message'
              and p.platform = ${input.platform} and t.at >= ${todayFrom}::timestamptz
              and not exists (select 1 from addon_outreach.friends f
                where f.profile_id = p.id and f.user_id = ${me} and f.state = 'friends')`,
      );
      const left = Math.min(openersLeft - openers, Math.max(0, requestsCap - (sentThere?.n ?? 0)));
      const waiting = left
        ? await rows<{ id: string; name: string; url: string; since: Date | string }>(
            ctx.tx,
            sql`select p.id, p.name, p.url, f.since from addon_outreach.friends f
                join addon_outreach.profiles p on p.id = f.profile_id
                where f.workspace_id = ${ws} and f.user_id = ${me} and f.state = 'request_sent'
                  and f.since between ${ago(TODAY_WINDOW_DAYS.opener)}::timestamptz
                    and ${ago(requestsAfter)}::timestamptz
                  and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
                  and exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                    and t.user_id = ${me} and t.kind = 'friend_request')
                  and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                    and t.kind = 'message')
                  and not exists (select 1 from addon_outreach.file_chats c where c.profile_id = p.id
                    and c.user_id = ${me})
                  and not exists (select 1 from addon_outreach.follow_ups fu where fu.profile_id = p.id
                    and fu.user_id = ${me})
                  and not exists (select 1 from addon_outreach.replies r where r.profile_id = p.id
                    and r.user_id = ${me})
                order by f.since desc limit ${left}`,
          )
        : [];
      for (const p of waiting)
        items.push(
          item({
            kind: 'opener',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [
              `You followed them ${dayWords(p.since, now)}, and they haven’t followed back`,
              REQUESTS_WHY,
            ],
            requests: true,
          }),
        );
    }

    // Send the link, Send the video, follow-ups and check-ins share the follow-ups' limit, in that order (the main
    // offer plan's "The conversation", ../conversation.ts).
    let followLeft = leftToday(limits, 'follow_up');
    const nowAt = new Date(now).toISOString();
    // The latest chat with someone, for where it's going: the person's own.
    const latestChat = (p: string) => sql`left join lateral (
        select c.id, c.thread_key, c.summary, c.next_step, c.pitch, c.pitch_why, c.last_at, c.last_from_me
        from addon_outreach.file_chats c where c.profile_id = ${sql.raw(p)}.id and c.user_id = ${me}
        order by c.last_at desc limit 1
      ) c on true`;
    const notBooked = (p: string) => sql`not exists (select 1 from addon_outreach.demos d
        where d.profile_id = ${sql.raw(p)}.id and d.user_id = ${me} and d.undone_at is null)`;

    // Send the link (decisions 47 and 66): someone who said yes to the video, or to the first message when there's no
    // video; or, in a chat that started another way, whose chat the AI read as ready for the offer, or the person
    // marked ready. Until the link goes, they're booked or not a fit, or the person writes to them again.
    if (followLeft > 0) {
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
        step: ConversationStep | null;
        said_yes: boolean;
      }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, c.id as chat_id, c.thread_key, c.summary, c.next_step, c.pitch_why,
              coalesce(s.mark = 'ready', false) as marked, f.step,
              coalesce(f.answer = 'yes' and f.stopped_at is null, false) as said_yes
            from addon_outreach.profiles p
            left join addon_outreach.stages s on s.profile_id = p.id and s.user_id = ${me}
            left join addon_outreach.follow_ups f on f.profile_id = p.id and f.user_id = ${me}
            ${latestChat('p')}
            where p.workspace_id = ${ws} and p.friendship <> 'self' and ${pitchable('p')} and ${lets}
              and (c.pitch = 'ready' or s.mark = 'ready'
                or (f.answer = 'yes' and f.stopped_at is null
                  and (f.step = 'video' or (f.step = 'first' and not ${hasVideo}))))
              and (s.id is null or (s.pitched_at is null and s.mark is distinct from 'lost'))
              and ${notBooked('p')}
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'message'
                  and t.at > greatest(c.last_at, s.marked_at, f.answered_at))
            order by greatest(c.last_at, s.marked_at, f.answered_at) desc nulls last, p.id
            limit ${followLeft}`,
      );
      followLeft -= ready.length;
      for (const p of ready)
        items.push(
          item({
            kind: 'pitch',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            chatId: p.chat_id,
            threadKey: p.thread_key,
            why: [
              p.said_yes
                ? p.step === 'video'
                  ? 'Said yes after your video'
                  : 'Said yes to your first message'
                : p.marked
                  ? 'You marked them ready'
                  : (p.pitch_why ?? 'Ready for your offer'),
            ],
            summary: p.summary,
            nextStep: p.next_step,
            demoLink: demoFor(p.id),
          }),
        );
    }

    // Send the video (decision 66): someone who said yes to the first message, when a playbook has a video.
    if (videoed && followLeft > 0) {
      const yes = await rows<{
        id: string;
        name: string;
        url: string;
        chat_id: string | null;
        thread_key: string | null;
        summary: string | null;
        next_step: string | null;
      }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, c.id as chat_id, c.thread_key, c.summary, c.next_step
            from addon_outreach.follow_ups f join addon_outreach.profiles p on p.id = f.profile_id
            ${latestChat('p')}
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.step = 'first' and f.answer = 'yes'
              and f.stopped_at is null
              and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets} and ${notBooked('p')}
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'message' and t.at > f.answered_at)
            order by f.answered_at desc, p.id
            limit ${followLeft}`,
      );
      followLeft -= yes.length;
      for (const p of yes)
        items.push(
          item({
            kind: 'video',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            chatId: p.chat_id,
            threadKey: p.thread_key,
            why: ['Said yes to your first message'],
            summary: p.summary,
            nextStep: p.next_step,
            videoLink: videoed.details.videoLink ?? null,
            demoLink: demoFor(p.id),
          }),
        );
    }

    // Follow-ups and check-ins (decision 67): whoever went quiet after a step, when the next one is due, until they
    // answer, say no or are marked not a fit. A reply seen or a newer message of theirs waits for the person instead;
    // a message the person wrote to them themselves lately puts it off a day. On a follow network nothing more goes in
    // a chat they haven't answered or accepted: a message to their Requests waits there, one only.
    const answeredOrAccepted = follows
      ? sql`(f.answer is not null
          or exists (select 1 from addon_outreach.friends fr
            where fr.profile_id = p.id and fr.user_id = ${me} and fr.state = 'friends')
          or exists (select 1 from addon_outreach.replies r
            where r.profile_id = p.id and r.user_id = ${me}))`
      : sql`true`;
    if (followLeft > 0) {
      const quiet = await rows<{
        id: string;
        name: string;
        url: string;
        chat_id: string | null;
        thread_key: string | null;
        summary: string | null;
        next_step: string | null;
        next: FollowUpNext;
        step: ConversationStep;
        sent: number;
        last_at: Date | string;
        answer: Answer | null;
      }>(
        ctx.tx,
        sql`select p.id, p.name, p.url, c.id as chat_id, c.thread_key, c.summary, c.next_step, f.next, f.step,
              f.sent, f.last_at, f.answer
            from addon_outreach.follow_ups f join addon_outreach.profiles p on p.id = f.profile_id
            ${latestChat('p')}
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.stopped_at is null
              and f.due_at <= ${nowAt}::timestamptz
              and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets} and ${notBooked('p')}
              and not exists (select 1 from addon_outreach.replies r
                where r.profile_id = f.profile_id and r.user_id = ${me} and r.seen_at > f.last_at)
              and (c.id is null or c.last_from_me or c.last_at <= f.last_at)
              and ${answeredOrAccepted}
              and not exists (select 1 from addon_outreach.touches t
                where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'message'
                  and t.at > greatest(f.last_at, ${ago(MANUAL_QUIET_HOURS / 24)}::timestamptz))
            order by f.due_at, p.id
            limit ${followLeft}`,
      );
      followLeft -= quiet.length;
      // Which follow-up of how many, and since when a check-in's been quiet, on the business's calendar.
      const { followUps: of } = await conversationPace(ctx);
      const zone = quiet.length ? await workspaceTimezone(ctx.tx, ws) : 'UTC';
      const day = (at: Date | string) =>
        new Date(at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          timeZone: intlTimeZone(zone),
        });
      for (const f of quiet)
        items.push(
          item({
            kind: f.next,
            name: f.name,
            profileId: f.id,
            profileUrl: f.url,
            chatId: f.chat_id,
            threadKey: f.thread_key,
            why:
              f.next === 'check_in'
                ? [
                    f.answer === 'later' ? 'Said not now' : `No answer since ${day(f.last_at)}`,
                    'once a month',
                  ]
                : [
                    `${CONVERSATION_STEPS[f.step]}, no answer yet`,
                    `${Math.min(f.sent + 1, of)} of ${of}`,
                  ],
            summary: f.summary,
            nextStep: f.next_step,
            demoLink: demoFor(f.id),
          }),
        );
    }
    const conversing = new Set(items.map((i) => i.profileId).filter(Boolean));

    // Follow-ups and replies in chats that started another way (Reconnect, the download file, someone who wrote
    // first): likely prospects whose chat's last message was the person's, a few quiet days ago, until their first
    // follow-up starts a conversation; and those who wrote last, lately.
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
            and c.platform = ${input.platform}
            and (p.id is null or (${pitchable('p')} and ${inPlay(me, 'p')}
              and (not c.last_from_me or ${lets})))
            and ((c.last_from_me and c.last_at between ${ago(TODAY_WINDOW_DAYS.follow_up)}::timestamptz
                  and ${ago(pace.firstGap)}::timestamptz
                  and not exists (select 1 from addon_outreach.follow_ups f
                    where f.profile_id = c.profile_id and f.user_id = ${me}))
              or (not c.last_from_me and c.last_at >= ${ago(TODAY_WINDOW_DAYS.reply)}::timestamptz))
            and not exists (select 1 from addon_outreach.touches t
              where t.profile_id = c.profile_id and t.user_id = ${me} and t.kind = 'message'
                and t.at > c.last_at)
          order by c.last_at desc limit ${TODAY_MOST * 2}`,
    );
    let replies = TODAY_MOST;
    for (const c of chats) {
      // Someone on the list already for the next step: that answers where the chat left off.
      if (c.profile_id && conversing.has(c.profile_id)) continue;
      const kind = c.last_from_me ? 'follow_up' : 'reply';
      if (kind === 'follow_up' ? followLeft-- <= 0 : replies-- <= 0) continue;
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
          where r.workspace_id = ${ws} and r.user_id = ${me} and p.platform = ${input.platform}
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
    // offers first (decision 49), then the newest. Where the network caps its answers to those (Alignable's forum, 2 a
    // day), only as many asking posts as are left of that today.
    const commentsLeft = Math.max(0, leftToday(limits, 'comment') - answers.length);
    const answersCap = NETWORKS[input.platform].forumAnswersPerDay;
    let askingLeft = commentsLeft;
    if (commentsLeft && answersCap !== null) {
      const [answered] = await rows<{ n: number }>(
        ctx.tx,
        sql`select count(*)::int as n from addon_outreach.touches t
            join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.kind = 'comment'
              and p.platform = ${input.platform} and t.at >= ${todayFrom}::timestamptz
              and exists (select 1 from addon_outreach.posts po
                where po.user_id = ${me} and po.url = t.post_url and po.strong)`,
      );
      askingLeft = Math.min(commentsLeft, Math.max(0, answersCap - (answered?.n ?? 0)));
    }
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
        sql`select * from (select po.id, po.url, po.posted, po.body, po.check_why, po.strong, po.seen_at,
              p.id as profile_id, p.name, p.url as profile_url, g.name as group_name, pb.name as playbook_name,
              row_number() over (partition by po.strong order by po.seen_at desc) as nth
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
                where t.user_id = ${me} and t.kind = 'comment' and t.post_url = po.url)) good
            where not good.strong or good.nth <= ${askingLeft}
            order by good.strong desc, good.seen_at desc limit ${commentsLeft}`,
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
              // A post off a group, from LinkedIn's post search, is on the network itself.
              ...(po.group_name
                ? [`In ${po.group_name}`]
                : input.platform === 'facebook'
                  ? []
                  : [`On ${NETWORKS[input.platform].name}`]),
            ],
            playbookName: po.playbook_name,
          }),
        );
    }

    // A business to recommend (the Instagram and Alignable plan's question 8), on a network with recommendations, one a
    // day and by hand only: a partner of theirs, or a customer they've done work for (a paid invoice or a job done),
    // never recommended by them before and never on Never contact. A different one each day, so one they'd rather not
    // waits. Vouching isn't pitching, so Don't pitch doesn't hold it back.
    if (NETWORKS[input.platform].recommends) {
      const [recommended] = await rows<{ n: number }>(
        ctx.tx,
        sql`select count(*)::int as n from addon_outreach.touches t
            join addon_outreach.profiles p on p.id = t.profile_id
            where t.workspace_id = ${ws} and t.user_id = ${me} and t.kind = 'recommend'
              and p.platform = ${input.platform} and t.at >= ${todayFrom}::timestamptz`,
      );
      const left = Math.max(0, RECOMMEND_PER_DAY - (recommended?.n ?? 0));
      const partnerOf = sql`exists (select 1 from addon_outreach.partners pa
        where pa.profile_id = p.id and pa.user_id = ${me} and pa.partner_at is not null)`;
      const vouched = left
        ? await rows<{ id: string; name: string; url: string; partner: boolean }>(
            ctx.tx,
            sql`select p.id, p.name, p.url, ${partnerOf} as partner
                from addon_outreach.profiles p
                where p.workspace_id = ${ws} and ${notNever('p')} and ${lets}
                  and (${partnerOf} or (p.person_id is not null and (
                    exists (select 1 from app.invoices i
                      where i.person_id = p.person_id and i.status = 'paid')
                    or exists (select 1 from app.jobs j
                      where j.person_id = p.person_id and j.status = 'done'))))
                  and not exists (select 1 from addon_outreach.touches t
                    where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'recommend')
                order by md5(p.id::text || ${todayFrom}) limit ${left}`,
          )
        : [];
      for (const p of vouched)
        items.push(
          item({
            kind: 'recommend',
            name: p.name,
            profileId: p.id,
            profileUrl: p.url,
            why: [p.partner ? RECOMMEND_WORDS.partner : RECOMMEND_WORDS.customer],
            nextStep: RECOMMEND_WORDS.next,
          }),
        );
    }

    const readAdmins = await rows<{ id: string; name: string | null; url: string }>(
      ctx.tx,
      sql`select g.id, g.name, g.url from addon_outreach.groups g
          where g.workspace_id = ${ws} and g.platform = ${input.platform} and g.admins_read_at is null
            and exists (select 1 from addon_outreach.group_people gp
              where gp.group_id = g.id and not gp.runs_group)
          order by g.seen_at desc nulls last limit 10`,
    );
    // The messages the extension drafted (../sends.ts): each with its item, and anyone skipped today off the list.
    const drafted = await sendsToday(ctx, me, todayFrom);
    // Who's in Contacts already, and who the person marked as having booked a demo: the web's menu on each. And what
    // the AI read in an answer of theirs not answered yet, for a reply's why.
    const profileIds = [...new Set(items.map((i) => i.profileId).filter((id) => id !== null))];
    const known = profileIds.length
      ? await rows<{
          id: string;
          person_id: string | null;
          marked: boolean;
          answer: Answer | null;
        }>(
          ctx.tx,
          sql`select p.id, p.person_id, exists (select 1 from addon_outreach.demos d
                where d.profile_id = p.id and d.user_id = ${me} and d.how = 'marked' and d.undone_at is null) as marked,
                (select f.answer from addon_outreach.follow_ups f
                  where f.profile_id = p.id and f.user_id = ${me} and f.answered_at >= f.last_at) as answer
              from addon_outreach.profiles p
              where p.workspace_id = ${ws} and p.id = any (${`{${profileIds.join(',')}}`}::uuid[])`,
        )
      : [];
    const knownOf = new Map(known.map((k) => [k.id, k]));
    // A message's chat, where it's going, to see beside it.
    const isMessage = (i: TodayItem) => (MESSAGE_KINDS as readonly string[]).includes(i.kind);
    const recent = await recentOf(ctx, me, items.filter(isMessage));
    // A post asking for what the business offers tops the list (decision 49): answered fast, before anything else.
    // The rest go in the kinds' order (../today.ts `TODAY_KINDS`), each kind as it was worked out.
    const order = new Map(TODAY_KIND_KEYS.map((k, i) => [k, i] as const));
    const byKind = (a: TodayItem, b: TodayItem) => order.get(a.kind)! - order.get(b.kind)!;
    const listedItems = [
      ...items.filter((i) => i.asking),
      ...items.filter((i) => !i.asking).sort(byKind),
    ]
      .filter((i) => !drafted.off(i.profileId, i.kind))
      .map((i) => {
        const send = drafted.open(i.profileId, i.kind);
        const k = i.profileId ? knownOf.get(i.profileId) : undefined;
        const answer = i.kind === 'reply' ? k?.answer : null;
        const why = answer ? [ANSWERS[answer], ...i.why] : i.why;
        return {
          ...i,
          // Each line in the network's own words: "Asked to be your connection" on LinkedIn.
          why: why.map((w) => inNetworkWords(w, input.platform)),
          personId: k?.person_id ?? null,
          demoBooked: k?.marked ?? false,
          recent: isMessage(i) ? (recent.get(chatKey(i)) ?? []) : [],
          ...(send ? { send } : {}),
        };
      });
    // Partners' steps (decision 81), after the customers': within what those left of each daily limit.
    const partnerItems = (
      await partnerToday(ctx, me, {
        platform: input.platform,
        now,
        todayFrom,
        left: partnerRoom(limits, listedItems),
      })
    ).filter((i) => !drafted.off(i.profileId, i.kind));
    const partnerRecent = await recentOf(ctx, me, partnerItems.filter(isMessage));
    const partnersListed = partnerItems.map((i) => {
      const send = drafted.open(i.profileId, i.kind);
      return {
        ...i,
        why: i.why.map((w) => inNetworkWords(w, input.platform)),
        recent: isMessage(i) ? (partnerRecent.get(chatKey(i)) ?? []) : [],
        ...(send ? { send } : {}),
      };
    });
    return {
      limits,
      items: ready ? listedItems : listedItems.filter((i) => i.kind === 'reply'),
      partners: ready ? partnersListed : partnersListed.filter((i) => i.kind === 'partner_reply'),
      readAdmins: readAdmins.map((g) => ({ groupId: g.id, name: g.name, url: g.url })),
      hasPlaybook: playbooks.length > 0,
      warning,
      auto: ready ? autoKinds(settings, input.platform) : [],
      messages: messageKinds(settings).filter(
        (k) => ready || k === 'reply' || k === 'partner_reply',
      ),
      sending: settings.sending,
      wheels,
      ready,
      week,
    };
  },
});

/** "today", "yesterday", "4 days ago". */
function dayWords(at: Date | string, now: number): string {
  const days = Math.floor((now - new Date(at).getTime()) / DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

export const todayQueries = [today] as const;
