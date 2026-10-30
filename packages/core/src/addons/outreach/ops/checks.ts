/**
 * The fits among the person's friends and chats (../checks.ts, docs/outreach.md decision 46): who the extension checks
 * next, what their pages said as it read them, and what the AI made of it. Each person's own, like their chats; nobody
 * goes in Contacts. The Friends tab lists them (./friends.ts), and Today has the good fits to reconnect with
 * (./today.ts).
 *
 * The same checks read people found by topic on Instagram, LinkedIn and Alignable (decision 92, ./finds.ts): each look
 * says whether it was of someone known or found (`via`), for the day's counts; the readers about people the person
 * knows decide by who they know now (`knownCheck`), so someone found who becomes a friend shows there at once. The
 * person's followers on Facebook who aren't friends (decision 113, ./followers.ts) are checked like friends, after
 * them, and counted with them (`via` `follower`); Today offers the good fits a friend request. People in the business's
 * Facebook groups who aren't friends (decision 116) are checked the same way, last of all (`via` `member`), and
 * Today's friend requests from the groups go by what the AI made of them.
 */
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { rows, type Tx } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import {
  CHECK_AGAIN_DAYS,
  CHECK_RETRY_DAYS,
  CHECKS_PER_DAY,
  RECONNECT_QUIET_DAYS,
  ChecksAgainInput,
  ChecksAgainOutput,
  CheckLookInput,
  CheckLookOutput,
  CheckSaveInput,
  CheckSaveOutput,
  ChecksNextInput,
  ChecksNextOutput,
  type CheckReason,
  type ChecksSummary,
  type CheckVerdict,
} from '../checks';
import { ASK_KEEP_DAYS } from '../asks';
import { requestModeOf } from '../automation';
import {
  countryRuleOn,
  linesCountry,
  lookedCountry,
  type CountryRule,
  type MutualCountries,
} from '../countries';
import { FIND_FRESH_DAYS, FIND_LIKES_BEHIND_DAYS, FOUND_CHECKS, type CheckVia } from '../finds';
import { bestFit } from '../fit';
import type { GroupCheckState } from '../group-checks';
import { FOLLOWERS_KEPT_DAYS } from '../followers';
import { fewAhead } from '../goal';
import { limitNow } from '../limits';
import { answersRequests, NETWORKS, profileMisfit, type Platform } from '../networks';
import { outreachAddon } from '../manifest';
import { partnerReadsPerDay } from '../partners';
import { requestsHeldOn, TODAY_WINDOW_DAYS } from '../today';
import type { ProfileRef } from '../saves';
import { checks, finds, profiles } from '../tables';
import { automationOf, limitsFor } from './automation';
import { findsByTopic } from './live';
import {
  countryFateSql,
  countryLetsSql,
  countryRuleOf,
  foundChecksOf,
  inPlay,
  inWorkspace,
  keepCountry,
  notOthers,
  pitchable,
  profilesFor,
  runsAGroup,
  waitsForLook,
  type Ctx,
} from './common';
import { playbooksInUse } from './friends';
import { groupFitOf } from './group-checks';
import { readinessFor } from './readiness';
import { slowsNow, startOfToday, warningOf } from './tidy';
import type { WarningState } from '../tidy';

const DAY = 86_400_000;

/** Someone the person knows: a friend of theirs, or someone they've chatted with that's kept as a profile. `p` is its alias. */
export const knowsThem = (
  me: string,
  p = 'p',
) => sql`(exists (select 1 from addon_outreach.friends f
    where f.profile_id = ${sql.raw(p)}.id and f.user_id = ${me} and f.state = 'friends')
  or exists (select 1 from addon_outreach.file_chats c where c.profile_id = ${sql.raw(p)}.id and c.user_id = ${me}))`;

/**
 * The people there are to check: the person's friends, and anyone they've chatted with that's kept as a profile;
 * never on Don't pitch or tagged Friend or family, and never themselves. `p` is the profile.
 */
export const knownToMe = (me: string) =>
  sql`p.friendship <> 'self' and ${pitchable('p')} and ${knowsThem(me)}`;

/**
 * A check of someone the person knows, decided now (decision 92), for the readers about them: Reconnect, the Friends
 * tab, Check everyone again and how far the checks have come. Either the look was of someone known (a Research press
 * counts), or the person found by topic has since become a friend or chatted, and shows there at once. A check of
 * someone found and not known yet is theirs alone: Today's found people. `ch` is the check, `p` its profile.
 */
export const knownCheck = (me: string) => sql`(ch.via = 'known' or ${knowsThem(me)})`;

/**
 * Someone the person knows whom a check found a good fit, or who might fit (decision 126, answer 5a), to write to again
 * (decision 46): neither side has written in `quiet`, nobody on the team wrote to them since, and they haven't written
 * back since. Today's Reconnect takes the good fits first; the day's goal counts every one ready. `ch` is the check, `p`
 * its profile, and `lets` the business's country setting and the network.
 */
export const reconnectReady = (me: string, quiet: string, lets: SQL) => sql`(ch.user_id = ${me}
  and ch.verdict in ('good', 'maybe') and ${knownCheck(me)}
  and p.friendship <> 'self' and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
  and not exists (select 1 from addon_outreach.file_chats c where c.profile_id = p.id and c.user_id = ${me}
    and c.last_at >= ${quiet}::timestamptz)
  and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
    and t.user_id = ${me} and t.kind = 'message' and t.at >= ${quiet}::timestamptz)
  and not exists (select 1 from addon_outreach.replies r where r.profile_id = p.id
    and r.user_id = ${me} and r.seen_at >= ${quiet}::timestamptz))`;

/**
 * Someone who sent the person a friend request they haven't answered (decision 136), the AI's to read: not one they
 * left as it is (Leave it) or pressed Confirm or Delete on since it came. `p` is the profile.
 */
export const asksMe = (me: string, p = 'p') => sql`exists (select 1 from addon_outreach.friends rq
    where rq.profile_id = ${sql.raw(p)}.id and rq.user_id = ${me} and rq.state = 'request_received'
      and not (rq.set_aside_at is not null and rq.set_aside_at >= rq.since)
      and not (rq.answer_at is not null and rq.answer_at >= rq.since))`;

/** Someone the person found by topic (decision 92) and doesn't know: a find of theirs, and no friend or chat. `p` is the profile. */
export const foundNotKnown = (me: string) => sql`(exists (select 1 from addon_outreach.finds fd
    where fd.profile_id = p.id and fd.user_id = ${me}) and not ${knowsThem(me)})`;

/**
 * One of the person's followers on Facebook (decision 113): seen on their list in the last three weeks. `p` is the
 * profile.
 */
export const followsMe = (me: string, now: number, p = 'p') => sql`exists (
    select 1 from addon_outreach.followers fo where fo.profile_id = ${sql.raw(p)}.id and fo.user_id = ${me}
      and fo.seen_at >= ${new Date(now - FOLLOWERS_KEPT_DAYS * DAY).toISOString()}::timestamptz)`;

/**
 * In one of the business's Facebook groups (decision 116): a member, not someone who runs it, of a group whose admins
 * have been read, and not a group someone else on the team is working. `p` is the profile.
 */
export const inMyGroups = (me: string) => sql`exists (select 1 from addon_outreach.group_people gp
    join addon_outreach.groups g on g.id = gp.group_id
    where gp.profile_id = p.id and g.admins_read_at is not null and not gp.runs_group
      and ${notOthers(me, 'g')})`;

/**
 * The person's own profile on its network (decision 92: never someone to find, check, comment on or reach), as the
 * check of their own profile in Get ready read it: its address or username (`setup.network_profiles`, Facebook's
 * `profile_check`). Until they've had it checked, the extension's readers leave them out on the page. `p` is the
 * profile.
 */
export const myOwnProfile = (me: string, p = 'p') => {
  const at = sql.raw(p);
  const address = (url: SQL) => sql`rtrim(lower(split_part(${url}, '?', 1)), '/')`;
  return sql`exists (select 1 from addon_outreach.setup s
    cross join lateral (select (case when ${at}.platform = 'facebook' then s.profile_check
      else s.network_profiles -> ${at}.platform -> 'check' end) -> 'seen' as seen) o
    where s.workspace_id = ${at}.workspace_id and s.user_id = ${me} and jsonb_typeof(o.seen) = 'object'
      and (lower(o.seen ->> 'username') = lower(${at}.username)
        or ${address(sql`o.seen ->> 'url'`)} = ${address(sql`${at}.url`)}))`;
};

/**
 * Someone found by topic who's still someone to reach (decision 92): not the person (`myOwnProfile`), a friend or
 * anyone asked either way, in Contacts or a client, left alone (Don't pitch, Never contact, a partner, not a fit) or
 * running a group. `p` is the profile.
 */
export const stillToReach = (
  me: string,
) => sql`(p.friendship not in ('self', 'friends', 'request_sent', 'request_received')
  and not ${myOwnProfile(me)}
  and p.person_id is null and ${pitchable('p')} and ${inPlay(me, 'p')} and not ${runsAGroup('p')}
  and not exists (select 1 from addon_outreach.friends fr where fr.profile_id = p.id and fr.user_id = ${me}
    and fr.state in ('friends', 'request_sent', 'request_received'))
  and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id and t.user_id = ${me}
    and t.kind = 'friend_request'))`;

/**
 * A find of the person's on a network waiting for the AI's check (decision 92): found in the last 14 days, not checked
 * by them yet (or a look that couldn't read them a week ago), still someone to reach, and not skipped by the business's
 * country setting: someone with no place is looked at, and the check's look says where. `f` is the find, `p` its
 * profile and `ch` the person's check of them, left joined.
 */
export function findToCheck(me: string, platform: Platform, rule: CountryRule, now: number) {
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  return sql`(f.user_id = ${me} and f.platform = ${platform}
    and f.found_at >= ${ago(FIND_FRESH_DAYS)}::timestamptz
    and (ch.id is null or (ch.verdict = 'failed' and ch.looked_at < ${ago(CHECK_RETRY_DAYS)}::timestamptz))
    and ${stillToReach(me)} and ${countryFateSql(rule, 'p')} <> 'skip')`;
}

/** How many of the person's finds on a network wait for the AI's check (`findToCheck`). */
export async function findsWaiting(
  ctx: Ctx,
  me: string,
  platform: Platform,
  now: number,
): Promise<number> {
  const [n] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_outreach.finds f
        join addon_outreach.profiles p on p.id = f.profile_id
        left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
        where f.workspace_id = ${ctx.scope.workspaceId!}
          and ${findToCheck(me, platform, await countryRuleOf(ctx), now)}`,
  );
  return n?.n ?? 0;
}

/**
 * The profiles the person's computer read today on a network for the AI: for its checks of who fits, of someone found
 * by topic (decision 92, counted by the look's `via`), and of who could partner (./partners.ts). All count toward the
 * network's profiles read a day; found people's only where they share them (`foundShareReads`).
 */
export async function readToday(
  ctx: Ctx,
  me: string,
  platform: Platform,
  todayStart: Date,
): Promise<{ checks: number; partners: number; found: number }> {
  const ws = ctx.scope.workspaceId!;
  const since = todayStart.toISOString();
  const [done] = await rows<{ checks: number; partners: number; found: number }>(
    ctx.tx,
    sql`select
          (select count(*) filter (where ch.via in ('known', 'follower', 'member', 'request'))::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and p.platform = ${platform}
              and ch.looked_at >= ${since}::timestamptz) as checks,
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and ch.via = 'found'
              and p.platform = ${platform} and ch.looked_at >= ${since}::timestamptz) as found,
          (select count(*)::int from addon_outreach.partners pa
            join addon_outreach.profiles p on p.id = pa.profile_id
            where pa.workspace_id = ${ws} and pa.user_id = ${me} and p.platform = ${platform}
              and pa.looked_at >= ${since}::timestamptz) as partners`,
  );
  return { checks: done?.checks ?? 0, partners: done?.partners ?? 0, found: done?.found ?? 0 };
}

/**
 * Whether the good fits found by topic who wait for their like, the warm-up before a request, are 2 days of the
 * network's likes or more (decision 92): no more are checked till Today catches up with them, so none of the day's
 * reads are held for them either.
 */
export async function likesBehind(
  ctx: Ctx,
  me: string,
  platform: Platform,
  now: number,
): Promise<boolean> {
  const todayStart = await startOfToday(ctx, now);
  const warned = slowsNow(await warningOf(ctx, me, platform, todayStart, now), now);
  const likes = (await limitsFor(ctx, me, warned, now, platform)).like;
  const [waiting] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from addon_outreach.finds f
        join addon_outreach.profiles p on p.id = f.profile_id
        join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me} and ch.verdict = 'good'
        where f.workspace_id = ${ctx.scope.workspaceId!} and f.user_id = ${me} and f.platform = ${platform}
          and f.found_at >= ${new Date(now - FIND_FRESH_DAYS * DAY).toISOString()}::timestamptz
          and ${stillToReach(me)} and ${countryLetsSql(await countryRuleOf(ctx), 'p')}
          and p.warm_up_missed_at is null
          and not exists (select 1 from addon_outreach.touches t
            where t.profile_id = p.id and t.user_id = ${me} and t.kind = 'like')`,
  );
  return (waiting?.n ?? 0) >= FIND_LIKES_BEHIND_DAYS * likes;
}

/**
 * The good fits ready on a network for the day's goal (decision 126): for a first message, friends to reconnect with and
 * new friends who accepted with no message yet, today's among them; and for a friend request, people found, following
 * them or in their groups whom a check found fit or might, still to reach. With whether new requests are held there
 * (decision 97).
 */
export async function goalStock(
  ctx: Ctx,
  me: string,
  platform: Platform,
  now: number,
): Promise<{ messages: number; requests: number; held: boolean }> {
  const ws = ctx.scope.workspaceId!;
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const lets = sql`(${countryLetsSql(await countryRuleOf(ctx), 'p')} and p.platform = ${platform})`;
  const [counted] = await rows<{
    reconnect: number;
    accepted: number;
    requests: number;
    waiting: number;
    friends: number;
  }>(
    ctx.tx,
    sql`select
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ${reconnectReady(me, ago(RECONNECT_QUIET_DAYS), lets)}) as reconnect,
          (select count(*)::int from addon_outreach.friends f
            join addon_outreach.profiles p on p.id = f.profile_id
            where f.workspace_id = ${ws} and f.user_id = ${me} and f.state = 'friends'
              and f.since >= ${ago(TODAY_WINDOW_DAYS.opener)}::timestamptz
              and ${pitchable('p')} and ${inPlay(me, 'p')} and ${lets}
              and exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.user_id = ${me} and t.kind = 'friend_request')
              and not exists (select 1 from addon_outreach.touches t where t.profile_id = p.id
                and t.kind = 'message')
              and not exists (select 1 from addon_outreach.file_chats c where c.profile_id = p.id
                and c.user_id = ${me})
              and not exists (select 1 from addon_outreach.follow_ups fu where fu.profile_id = p.id
                and fu.user_id = ${me})) as accepted,
          (select count(*)::int from addon_outreach.checks ch
            join addon_outreach.profiles p on p.id = ch.profile_id
            where ch.workspace_id = ${ws} and ch.user_id = ${me} and ch.verdict in ('good', 'maybe')
              and ch.via in ('found', 'follower', 'member')
              and ch.looked_at >= ${ago(FIND_FRESH_DAYS)}::timestamptz
              and ${stillToReach(me)} and ${lets}) as requests,
          (select count(*) filter (where f.state = 'request_sent')::int from addon_outreach.friends f
            join addon_outreach.profiles p on p.id = f.profile_id
            where f.workspace_id = ${ws} and f.user_id = ${me} and p.platform = ${platform}) as waiting,
          (select count(*) filter (where f.state = 'friends')::int from addon_outreach.friends f
            join addon_outreach.profiles p on p.id = f.profile_id
            where f.workspace_id = ${ws} and f.user_id = ${me} and p.platform = ${platform}) as friends`,
  );
  return {
    messages: (counted?.reconnect ?? 0) + (counted?.accepted ?? 0),
    requests: counted?.requests ?? 0,
    held:
      requestsHeldOn(platform, {
        waiting: counted?.waiting ?? 0,
        friends: counted?.friends ?? 0,
      }) !== null,
  };
}

/**
 * Whether a network checks more and searches again today (decision 126, answer 6a): the person is ready there (nothing
 * goes out till then, decision 69), and it has fewer good fits ready for first messages than `GOAL_AHEAD_DAYS` days of
 * its limit, or, while new requests aren't held there by a warning or the person's own, fewer to ask than that many
 * days of requests.
 */
export async function moreToday(
  ctx: Ctx,
  me: string,
  platform: Platform,
  now: number,
  warning: WarningState | null,
): Promise<boolean> {
  if (!(await readinessFor(ctx, me, platform)).ready) return false;
  const limits = await limitsFor(ctx, me, slowsNow(warning, now), now, platform);
  const stock = await goalStock(ctx, me, platform, now);
  const requestsOff =
    stock.held || (warning !== null && new Date(warning.requestsFrom).getTime() > now);
  return (
    fewAhead(stock.messages, limits.first_message) ||
    (!requestsOff && fewAhead(stock.requests, limits.friend_request))
  );
}

/**
 * The network's profiles read a day (`checksPerDay`), or its most (`checksMost`) on a day it needs more good fits
 * (decision 126, answer 4a); halved for a week after a warning there, and the most halved too while the person is new
 * there or on training wheels (`slower`, answer 2a).
 */
export const readsPerDay = (platform: Platform, slower: boolean, more = false) =>
  limitNow(
    more
      ? NETWORKS[platform].checksMost
      : Math.min(CHECKS_PER_DAY, NETWORKS[platform].checksPerDay),
    slower,
  );

/** A day's reads of one kind on a network: how many today, how many a day now, and how many more today has room for. */
export interface DayReads {
  readonly today: number;
  readonly perDay: number;
  readonly room: number;
}

/**
 * How many profiles the person's computer reads a day on a network now, and how many more today, for each kind of
 * read. Another network's reads and warnings never count.
 *
 * - **Checks** of people they know: the network's profiles read a day (`checksPerDay`), or its most (`checksMost`)
 *   on a day the goal needs more good fits (decision 126, `moreToday`), halved for a week after a warning there;
 *   today's partner reads count too.
 * - **Partners**: at most half of those (`partnerReadsPerDay`), inside what the checks leave (./partners.ts).
 * - **Found** people (decision 92): the business's found checks a day (decision 116, `foundChecksOf`; twice that, up to
 *   `FOUND_CHECKS.most`, on a day the goal needs more), halved on training wheels there too
 *   and for a week after a warning, never below 1, beside the profiles read. Where they share them instead
 *   (`foundShareReads`, LinkedIn's settled 40), found people go first: up to their day's, inside the profiles read, the
 *   found checks still to come today hold their part (as many as wait, only while the person's computer finds people
 *   by topic, and never while likes are behind: `likesBehind`), and the checks and partner reads take what's left. The
 *   network's limit never grows.
 */
export async function perDayFor(
  ctx: Ctx,
  me: string,
  now: number,
  platform: Platform = 'facebook',
  /** Whether the day needs more good fits there, when the caller worked it out already (`moreToday`). */
  needsMore?: boolean,
): Promise<{ checks: DayReads; partners: DayReads; found: DayReads }> {
  const todayStart = await startOfToday(ctx, now);
  const warning = await warningOf(ctx, me, platform, todayStart, now);
  const warned = slowsNow(warning, now);
  const read = await readToday(ctx, me, platform, todayStart);
  // More on a day the goal needs more good fits (decision 126), half that while the person is new there.
  const more = needsMore ?? (await moreToday(ctx, me, platform, now, warning));
  const slowerMore = more && (warned || (await automationOf(ctx, me, now, platform)).slower);
  const reads = readsPerDay(platform, warned || slowerMore, more);
  const kit = NETWORKS[platform];
  const shared = kit.foundShareReads;
  const used = read.checks + read.partners + (shared ? read.found : 0);
  const left = Math.max(0, reads - used);
  let found: DayReads = { today: read.found, perDay: 0, room: 0 };
  let held = 0;
  const foundChecks = await foundChecksOf(ctx, platform);
  if (foundChecks !== null) {
    const slower = warned || (await automationOf(ctx, me, now, platform)).slower;
    // Twice the business's, up to the most it may set, on a day the goal needs more (decision 126).
    const most = limitNow(
      more ? Math.min(FOUND_CHECKS.most, foundChecks * 2) : foundChecks,
      slower,
    );
    const perDay = shared ? Math.min(most, reads) : most;
    const room = Math.max(0, perDay - read.found);
    found = { today: read.found, perDay, room: shared ? Math.min(room, left) : room };
    // Held only for a computer that checks them (0.95.0 and later): an older build never does, so its reads stay whole.
    // None while the good fits wait on their likes: no found checks run then (`outreach.finds.next`).
    if (
      shared &&
      found.room &&
      (await findsByTopic(ctx, me)) &&
      !(await likesBehind(ctx, me, platform, now))
    )
      held = Math.min(found.room, await findsWaiting(ctx, me, platform, now));
  }
  const free = left - held;
  const partners = partnerReadsPerDay(reads);
  return {
    checks: { today: used, perDay: reads, room: free },
    partners: {
      today: read.partners,
      perDay: partners,
      room: Math.min(Math.max(0, partners - read.partners), free),
    },
    found,
  };
}

/** How far the person's checks of the people they know have come, for the Friends tab. */
export async function checksSummary(
  ctx: Ctx,
  me: string,
  now = Date.now(),
): Promise<ChecksSummary> {
  const ws = ctx.scope.workspaceId!;
  const [counted] = await rows<{
    people: number;
    checked: number;
    good: number;
    maybe: number;
    waiting: number;
    again: number;
  }>(
    ctx.tx,
    sql`select count(*)::int as people,
          count(*) filter (where ch.verdict in ('good', 'maybe', 'not'))::int as checked,
          count(*) filter (where ch.verdict = 'good')::int as good,
          count(*) filter (where ch.verdict = 'maybe')::int as maybe,
          count(*) filter (where ch.verdict = 'waiting')::int as waiting,
          count(*) filter (where ch.again)::int as again
        from addon_outreach.profiles p
        left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
        where p.workspace_id = ${ws} and ${knownToMe(me)}`,
  );
  const { checks: day } = await perDayFor(ctx, me, now);
  return {
    people: counted?.people ?? 0,
    checked: counted?.checked ?? 0,
    good: counted?.good ?? 0,
    maybe: counted?.maybe ?? 0,
    waiting: counted?.waiting ?? 0,
    again: counted?.again ?? 0,
    today: day.today,
    perDay: day.perDay,
  };
}

export const checksNext = defineAddonQuery(outreachAddon, {
  name: 'outreach.checks.next',
  description:
    'Who the person’s computer checks next for whether they fit a playbook, in order and no more than today has room for: anyone they pressed Research on, anyone who sent them a friend request they haven’t answered (for what to do with it), anyone waiting for a look at where they live (those asking to be friends first), friends whose chat looks like a prospect, then friends with any chat, others they’ve chatted with, friends from the groups, the rest of their friends, their followers on Facebook who aren’t friends yet, then people in the business’s Facebook groups who aren’t friends, the best fit first. Never anyone on Don’t pitch, nor anyone checked lately unless the person asked to check everyone again or they wait for a look.',
  input: ChecksNextInput,
  output: ChecksNextOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_checks_next',
    keywords: ['who gets checked next', 'fit checks'],
  },
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const now = Date.now();
    const { checks: day } = await perDayFor(ctx, me, now, input.platform);
    const { today, perDay } = day;
    const room = Math.max(0, Math.min(input.most, day.room));
    if (!room) return { people: [], today, perDay };
    const ago = (days: number) => new Date(now - days * DAY).toISOString();
    // Pressed Research (decision 46a) since they were last read: they go first, whoever they are to the person.
    const asked = sql`exists (select 1 from addon_outreach.asks a
      where a.workspace_id = p.workspace_id and a.user_id = ${me} and a.kind = 'research'
        and a.target = 'profile:' || p.id::text and a.state <> 'cancelled'
        and a.asked_at > ${ago(ASK_KEEP_DAYS)}::timestamptz
        and (ch.id is null or a.asked_at > ch.looked_at))`;
    // Waiting for a look at where they live (decision 86): a From or a guess the country setting would skip. Not
    // someone found by topic the person doesn't know: their own check looks (decision 92, `outreach.finds.next`).
    const rule = await countryRuleOf(ctx);
    const look = sql`(${waitsForLook(rule, 'p')} and not ${foundNotKnown(me)})`;
    // A friend request they got that the extension answers as the AI says (decision 136): read first after a Research
    // press. Not while they confirm or delete them all, when what the AI says changes nothing.
    const answering = requestModeOf((await automationOf(ctx, me, now, input.platform)).choices);
    const asking =
      answersRequests(input.platform) && answering !== 'all' && answering !== 'delete'
        ? asksMe(me)
        : sql`false`;
    // A follower on Facebook who isn't a friend (decision 113), still someone to reach: checked like a friend, after them.
    const follower = sql`(${followsMe(me, now)} and not ${knowsThem(me)} and ${stillToReach(me)})`;
    // Not checked yet, asked to be again, or checked long enough ago. `ch` is their check.
    const due = sql`(ch.id is null
      or (ch.again and ch.verdict <> 'waiting')
      or (ch.verdict in ('good', 'maybe', 'not') and ch.checked_at < ${ago(CHECK_AGAIN_DAYS)}::timestamptz)
      or (ch.verdict = 'failed' and ch.looked_at < ${ago(CHECK_RETRY_DAYS)}::timestamptz)
      or (${asking} and ch.verdict in ('good', 'maybe', 'not') and ch.request_answer is null))`;
    const who = input.profileId
      ? sql`p.id = ${input.profileId} and p.friendship <> 'self' and ${pitchable('p')}`
      : sql`(${knownToMe(me)} or ${follower}
          or (p.friendship <> 'self' and ${pitchable('p')} and (${asked} or ${asking} or ${look})))`;
    const found = await rows<{ id: string; name: string; url: string; reason: CheckReason }>(
      ctx.tx,
      sql`select x.id, x.name, x.url, x.reason from (
            select p.id, p.name, p.url, p.mutual_friends, p.updated_at, p.friendship,
              case
                when ${asked} then 'asked'
                when ${asking} then 'request'
                when ${look} then 'country'
                when f.id is not null and c.prospect then 'prospect'
                when f.id is not null and c.id is not null then 'chat'
                when c.id is not null then 'chat_only'
                when f.id is null and ${follower} then 'follower'
                when p.group_id is not null then 'group'
                else 'friend'
              end as reason
            from addon_outreach.profiles p
            left join addon_outreach.friends f
              on f.profile_id = p.id and f.user_id = ${me} and f.state = 'friends'
            left join lateral (
              select c.id, coalesce(c.prospect, false) as prospect from addon_outreach.file_chats c
              where c.profile_id = p.id and c.user_id = ${me}
              order by c.prospect desc nulls last, c.last_at desc limit 1
            ) c on true
            left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
            where p.workspace_id = ${ws} and ${who}
              and p.platform = ${input.platform}
              and (${due}
                or (ch.verdict = 'failed' and ${asked})
                or (${look} and ch.verdict in ('good', 'maybe', 'not')))
          ) x
          order by array_position(
              array['asked', 'request', 'country', 'prospect', 'chat', 'chat_only', 'group', 'friend', 'follower',
                'member'],
              x.reason),
            (x.reason = 'country' and x.friendship = 'request_received') desc,
            x.mutual_friends desc nulls last, x.updated_at desc, x.id
          limit ${room}`,
    );
    // People in the business's Facebook groups who aren't friends (decision 116): last of all, in what room is left.
    const members =
      input.platform === 'facebook' && !input.profileId && found.length < room
        ? await membersNext(ctx, me, room - found.length, due, new Set(found.map((p) => p.id)))
        : [];
    // Where their mutual friends live helps say where they do, while the business reaches only some countries.
    const mutual = countryRuleOn(rule) && input.platform === 'facebook';
    return {
      people: [...found, ...members.map((p) => ({ ...p, reason: 'member' as const }))].map((p) => ({
        profileId: p.id,
        name: p.name,
        url: p.url,
        reason: p.reason,
        mutual,
      })),
      today,
      perDay,
    };
  },
});

/** The most group members weighed at once for who to check next. */
const MEMBERS_WEIGHED = 500;

/**
 * Facebook's group members to check next (decision 116): people in the business's groups (`inMyGroups`) whom Today
 * could offer a friend request, weighed as it weighs them: the best fit by the lines under their name first, the
 * person's own groups and those the AI says their people are in a little ahead. Never anyone in a group the playbooks
 * skip, nor anyone their lines skip, nor anyone whose check isn't due (`due`, `ch` their check), nor those in
 * `leaveOut`.
 */
async function membersNext(
  ctx: Ctx,
  me: string,
  most: number,
  due: SQL,
  leaveOut: ReadonlySet<string>,
): Promise<{ id: string; name: string; url: string }[]> {
  const playbooks = await playbooksInUse(ctx, 'facebook');
  if (!playbooks.length) return [];
  const lets = countryLetsSql(await countryRuleOf(ctx), 'p');
  const found = await rows<{
    id: string;
    name: string;
    url: string;
    intro: string[];
    mutual_friends: number | null;
    lines: string[];
    group_name: string | null;
    group_detail: string | null;
    group_members: number | null;
    group_privacy: 'public' | 'private' | null;
    check_state: GroupCheckState | null;
    check_why: string[];
    check_playbook_id: string | null;
    in_group: boolean;
  }>(
    ctx.tx,
    sql`select distinct on (p.id) p.id, p.name, p.url, p.intro, p.mutual_friends, gp.lines,
          g.name as group_name, g.detail as group_detail, g.members as group_members,
          g.privacy as group_privacy, g.check_state, g.check_why, g.check_playbook_id,
          exists (select 1 from addon_outreach.my_groups m
            where m.group_id = g.id and m.user_id = ${me} and m.joined) as in_group
        from addon_outreach.group_people gp
        join addon_outreach.groups g on g.id = gp.group_id
        join addon_outreach.profiles p on p.id = gp.profile_id
        left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
        where gp.workspace_id = ${ctx.scope.workspaceId!} and g.platform = 'facebook'
          and g.admins_read_at is not null and not gp.runs_group and ${notOthers(me, 'g')}
          and ${stillToReach(me)} and not ${knowsThem(me)} and ${lets}
          and not exists (select 1 from addon_outreach.touches t
            where t.profile_id = p.id and t.kind = 'friend_request')
          and ${due}
        order by p.id, gp.seen_at desc
        limit ${MEMBERS_WEIGHED}`,
  );
  return found
    .flatMap((p) => {
      if (leaveOut.has(p.id)) return [];
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
      if (fit.level === 'skip') return [];
      return [{ p, score: fit.score + (p.in_group ? 1 : 0) + (p.check_state === 'good' ? 1 : 0) }];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.p.mutual_friends ?? 0) - (a.p.mutual_friends ?? 0) ||
        a.p.name.localeCompare(b.p.name),
    )
    .slice(0, most)
    .map(({ p }) => ({ id: p.id, name: p.name, url: p.url }));
}

/**
 * Where someone's mutual friends live, as far as the business knows (decision 86): each country, the most first, with
 * how many were seen on a profile and how many worked out else. Null when the look didn't read them. The worker's check
 * reads it too.
 */
export async function mutualCountries(
  tx: Tx,
  workspaceId: string,
  ids: readonly string[],
  read: number | null,
): Promise<MutualCountries | null> {
  if (read === null) return null;
  const by = ids.length
    ? await rows<{ code: string; seen: number; other: number }>(
        tx,
        sql`select country as code, count(*) filter (where country_how = 'seen')::int as seen,
              count(*) filter (where country_how <> 'seen')::int as other
            from addon_outreach.profiles
            where workspace_id = ${workspaceId} and id = any (${`{${ids.join(',')}}`}::uuid[])
              and country is not null
            group by country order by count(*) desc, country limit 40`,
      )
    : [];
  return { read, by };
}

/**
 * The keys a read of someone's own page adds to the one they're kept by (decision 131): their network's number when
 * they're kept by the name in their address, or that name when they're kept by the number. Only from a page that
 * showed the key they're kept by, and never a key another profile here has: that one stays as it is.
 */
async function keysSeen(
  ctx: Ctx,
  had: {
    readonly platform: Platform;
    readonly platformId: string | null;
    readonly username: string | null;
  },
  seen: ProfileRef | null,
): Promise<{ platformId?: string; username?: string }> {
  if (!seen || profileMisfit(had.platform, seen)) return {};
  const theirs =
    (had.platformId !== null && seen.id === had.platformId) ||
    (had.username !== null && seen.username?.toLowerCase() === had.username.toLowerCase());
  const id = theirs && !had.platformId ? seen.id : null;
  const username = theirs && !had.username ? seen.username : null;
  if (!id && !username) return {};
  const taken = await profilesFor(ctx, had.platform, { id, username });
  return {
    ...(id && !taken.some((p) => p.platformId === id) ? { platformId: id } : {}),
    ...(username && !taken.some((p) => p.username?.toLowerCase() === username.toLowerCase())
      ? { username }
      : {}),
  };
}

export const checkLook = defineAddonCommand(outreachAddon, {
  name: 'outreach.check.look',
  description:
    'What someone says on their profile and business page, as the person’s computer just read it, with how many friends they have and their mutual friends with the person, for the AI to see whether they fit a playbook and where they live; or that the network showed someone else. Someone the person knows, or someone found by topic they don’t know yet, whose check counts on its own. Kept only until the AI has read it.',
  risk: 1,
  input: CheckLookInput,
  output: CheckLookOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.check.looked'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [profile] = await ctx.tx
      .select({
        id: profiles.id,
        platform: profiles.platform,
        platformId: profiles.platformId,
        username: profiles.username,
      })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    if (!profile)
      throw HfosError.notFound('That person isn’t kept here anymore. Check your friends again.');
    const verdict: CheckVerdict = input.missing ? 'failed' : 'waiting';
    // Of someone found by topic the person doesn't know (decision 92), counted on its own a day; else of someone known,
    // as is anyone they pressed Research on since the last look (decision 46a). Set at each look, so it's kept fresh.
    // One of their followers on Facebook who isn't a friend (decision 113), or someone in one of the business's groups
    // there who isn't (decision 116): checked like a friend, and counted with them, but shown with the people they
    // know only once they are one. Someone who sent them a friend request they haven't answered (decision 136): the
    // AI says what to do with it too, and they show with the people they know once they're friends.
    const [seen] = await rows<{
      asked: boolean;
      request: boolean;
      found: boolean;
      follower: boolean;
      member: boolean;
    }>(
      ctx.tx,
      sql`select exists (select 1 from addon_outreach.asks a
              where a.workspace_id = p.workspace_id and a.user_id = ${me} and a.kind = 'research'
                and a.target = 'profile:' || p.id::text and a.state <> 'cancelled'
                and a.asked_at > ${new Date(at.getTime() - ASK_KEEP_DAYS * DAY).toISOString()}::timestamptz
                and (ch.id is null or a.asked_at > ch.looked_at)) as asked,
            ${asksMe(me)} as request,
            ${foundNotKnown(me)} as found,
            (${followsMe(me, at.getTime())} and not ${knowsThem(me)}) as follower,
            (p.platform = 'facebook' and ${inMyGroups(me)} and not ${knowsThem(me)}) as member
          from addon_outreach.profiles p
          left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = ${me}
          where p.workspace_id = ${ws} and p.id = ${profile.id}`,
    );
    const via: CheckVia =
      !seen || seen.asked
        ? 'known'
        : seen.request
          ? 'request'
          : seen.found
            ? 'found'
            : seen.follower
              ? 'follower'
              : seen.member
                ? 'member'
                : 'known';
    // Their mutual friends (decision 86), matched to the people the business keeps on the network, for where they live.
    const mutual = input.missing ? null : input.mutual;
    const ids = (mutual ?? []).flatMap((m) => (m.id ? [m.id] : []));
    const usernames = (mutual ?? []).flatMap((m) => (m.username ? [m.username.toLowerCase()] : []));
    const mutualIds = mutual?.length
      ? (
          await rows<{ id: string }>(
            ctx.tx,
            sql`select id from addon_outreach.profiles
                where workspace_id = ${ws} and platform = ${profile.platform} and id <> ${profile.id}
                  and (platform_id = any (${`{${ids.join(',')}}`}::text[])
                    or lower(username) = any (${`{${usernames.join(',')}}`}::text[]))`,
          )
        ).map((r) => r.id)
      : [];
    const fresh = {
      ...(input.missing ? {} : await keysSeen(ctx, profile, input.seen)),
      ...(!input.missing && input.friendsCount !== null
        ? { friendsCount: input.friendsCount }
        : {}),
    };
    if (Object.keys(fresh).length)
      await ctx.tx.update(profiles).set(fresh).where(eq(profiles.id, profile.id));
    const why = input.missing
      ? [`${NETWORKS[profile.platform].name} didn’t show their profile`]
      : [];
    const [row] = await ctx.tx
      .insert(checks)
      .values({
        workspaceId: ws,
        userId: me,
        profileId: profile.id,
        lines: input.missing ? [] : input.lines,
        mutualIds,
        mutualRead: mutual ? mutual.length : null,
        verdict,
        why,
        lookedAt: at,
        via,
      })
      .onConflictDoUpdate({
        target: [checks.workspaceId, checks.userId, checks.profileId],
        set: {
          lines: input.missing ? [] : input.lines,
          mutualIds,
          mutualRead: mutual ? mutual.length : null,
          verdict,
          via,
          // A new read keeps the last answer on show until the AI's next one.
          ...(input.missing
            ? { why, about: null, nextStep: null, playbookId: null, checkedAt: null }
            : {}),
          lookedAt: at,
          again: false,
        },
      })
      .returning({ id: checks.id });
    if (verdict === 'waiting')
      await ctx.emit({
        type: 'outreach.check.looked',
        entityType: 'workspace',
        entityId: ws,
        payload: { checkId: row!.id },
      });
    return { checkId: row!.id, verdict };
  },
});

export const checkSave = defineAddonCommand(outreachAddon, {
  name: 'outreach.check.save',
  description:
    'Worker: what the AI made of someone the person knows, found by topic, or who asked to be friends: a good fit, might fit or not, for which playbook, why, who they are and a first step, where they live (a Lives in on their profile beats its word), and for a friend request whether to confirm it, delete it or leave it to the person; or that it couldn’t read them. What their pages said, their mutual friends and what they said under a post are let go.',
  risk: 0,
  input: CheckSaveInput,
  output: CheckSaveOutput,
  permission: 'outreach.use',
  actors: ['system'],
  scope: inWorkspace,
  emits: ['outreach.check.saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta);
    const [check] = await ctx.tx
      .select()
      .from(checks)
      .where(and(eq(checks.workspaceId, ws), eq(checks.id, input.checkId)))
      .for('update');
    if (!check) throw HfosError.notFound('That check isn’t kept anymore.');
    // Answered already, or read again since: this answer is for lines that are gone.
    if (
      check.verdict !== 'waiting' ||
      check.lookedAt.getTime() !== new Date(input.lookedAt).getTime()
    )
      return { saved: false, verdict: check.verdict };
    const a = input.answer;
    const verdict: CheckVerdict = a ? a.fit : 'failed';
    // Where they live (decisions 61 and 86): a look weighs their pages' lines, their mutual friends and the AI's word.
    // With no answer, the lines alone count, as the worker's would, and never undo a stronger one.
    if (a?.country) {
      const looked = lookedCountry(check.lines, a.country);
      await ctx.tx
        .update(profiles)
        .set({
          country: looked.country,
          countryHow: looked.how,
          countryAt: at,
          countryFrom: looked.from,
          countryAlt: looked.alt,
          countryWhy: looked.why,
          countryUnsure: looked.unsure,
          countryLookedAt: at,
          countryMutual: await mutualCountries(ctx.tx, ws, check.mutualIds, check.mutualRead),
        })
        .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, check.profileId)));
    } else {
      const lined = linesCountry(check.lines);
      if (lined) await keepCountry(ctx, check.profileId, lined);
    }
    await ctx.tx
      .update(checks)
      .set({
        lines: [],
        mutualIds: [],
        verdict,
        playbookId: a?.playbookId ?? null,
        why: a?.why ?? ['The AI couldn’t read them'],
        about: a?.about ?? null,
        nextStep: a?.nextStep ?? null,
        partnerHint: a?.partner ?? null,
        // Of someone who asked to be friends (decision 136): kept until the next answer; one that couldn't be read says
        // nothing of their request, so it waits for the person.
        ...(check.via === 'request' || a?.request
          ? { requestAnswer: a?.request?.answer ?? null, requestWhy: a?.request?.why ?? null }
          : {}),
        checkedAt: at,
      })
      .where(eq(checks.id, check.id));
    // What they said under a good post, if they were found commenting on one (decision 92), goes once it's read too.
    await ctx.tx
      .update(finds)
      .set({ said: null, saidAt: null, updatedAt: at })
      .where(
        and(
          eq(finds.workspaceId, ws),
          eq(finds.userId, check.userId),
          eq(finds.profileId, check.profileId),
          isNotNull(finds.said),
        ),
      );
    await ctx.emit({
      type: 'outreach.check.saved',
      entityType: 'workspace',
      entityId: ws,
      payload: { checkId: check.id, verdict },
    });
    return { saved: true, verdict };
  },
});

/**
 * Check everyone again: everyone the person's computer has checked among the people they know is read again, at the
 * day's pace, whenever it last was. For when the AI reads pages better than it did; what it said stays on show until
 * then.
 */
export const checksAgain = defineAddonCommand(outreachAddon, {
  name: 'outreach.checks.again',
  description:
    'Puts everyone the person’s computer has checked among the people they know back on the list to check, at the day’s pace, so the AI reads them again. What it said about each stays until then. People found by topic they don’t know yet aren’t among them.',
  risk: 1,
  input: ChecksAgainInput,
  output: ChecksAgainOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_check_again',
    autonomy: 'confirm',
    keywords: ['check everyone again', 'redo fit checks'],
  },
  scope: inWorkspace,
  emits: ['outreach.checks.again'],
  async handler(ctx) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    // Only checks of people the person knows, decided now (decision 92): someone found who became a friend is one.
    const marked = await rows<{ id: string }>(
      ctx.tx,
      sql`update addon_outreach.checks ch set again = true
          from addon_outreach.profiles p
          where p.id = ch.profile_id and ch.workspace_id = ${ws} and ch.user_id = ${me}
            and not ch.again and ch.verdict <> 'waiting' and ${knownCheck(me)}
          returning ch.id`,
    );
    if (marked.length)
      await ctx.emit({
        type: 'outreach.checks.again',
        entityType: 'workspace',
        entityId: ws,
        payload: { again: marked.length },
      });
    return { again: marked.length };
  },
});

export const checkCommands = [checkLook, checkSave, checksAgain] as const;
export const checkQueries = [checksNext] as const;
