/**
 * Waiting for you (../waiting.ts, docs/outreach.md decisions 40 and 42): one list, worked out each time it's asked for,
 * of what the person asked of their computer that waits on them there (decision 43), the messages waiting for the person's OK (replies handed over first), the steps the extension needs them for, and
 * the friend requests that are theirs to decide; and its actions: I did it and Let it go for a need, Leave it for a
 * request (a message's are `outreach.send.*`). The Live tab, the team view, the extension's icon and the pushes all
 * count what waits here (`waitingFor`), so they never disagree. Each person's are their own.
 */
import { and, eq, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { workspaceTimezone } from '../../../crm/records';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import { changeMoment } from '../../../kernel/moment';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import type { FitPlaybook } from '../fit';
import { outreachAddon } from '../manifest';
import {
  choicesFor,
  readsRequests,
  requestAnswerOf,
  requestModeOf,
  underAPost,
  type RequestMode,
} from '../automation';
import type { CheckVerdict } from '../checks';
import { answersRequests, NETWORKS, PLATFORM_KEYS, type Platform } from '../networks';
import { friends, needs, posts, profiles, sends } from '../tables';
import {
  NEED_SHOWN_DAYS,
  NeedClearInput,
  NeedClearOutput,
  NeedNoteInput,
  NeedNoteOutput,
  needUrlOf,
  NO_KINDS,
  REQUEST_READ_DAYS,
  REQUEST_SHOWN_DAYS,
  requestWhy,
  RequestAnswerInput,
  RequestAnswerOutput,
  RequestSetAsideInput,
  RequestSetAsideOutput,
  WAITING_SHOWN_MOST,
  waitingCount,
  WaitingInput,
  WaitingOutput,
  type RequestHeld,
  type RequestKept,
  type RequestRead,
  type WaitingItem,
  type WaitingKinds,
  type WaitingNeed,
  type WaitingRequest,
} from '../waiting';
import { asksNeedingYou } from './ask-rows';
import { automationOf, everyoneAutomation } from './automation';
import { contactable, inWorkspace, neverDeleted, requestAnswerColumns, type Ctx } from './common';
import { playbooksInUse } from './friends';
import { openNeed } from './needs';
import { commentHoldOf, listed, mine } from './sends';
import { notNever, requestFit, type RequestAnswered } from './today';

const DAY = 86_400_000;
/** The most requests lately weighed a person at once: more than Facebook lets anyone keep waiting a fortnight. */
const REQUESTS_MOST = 500;

const ids = (userIds: readonly string[]) => `{${userIds.join(',')}}`;
const iso = (at: Date | string | null) => (at === null ? null : new Date(at).toISOString());

/**
 * A need shown (`private.outreach_need_shown`, one copy on the database): open, the extension couldn't do it within
 * the week, and the step not taken some other way since (a request answered, or one sent, as Facebook's lists showed).
 */
const shownSince = (now: number) => new Date(now - NEED_SHOWN_DAYS * DAY).toISOString();

/** Each person's messages waiting, split into replies handed over and the rest, and their needs shown. */
async function sendAndNeedKinds(
  ctx: Ctx,
  userIds: readonly string[],
  now: number,
): Promise<Map<string, WaitingKinds>> {
  const kinds = new Map(userIds.map((id) => [id, structuredClone(NO_KINDS) as WaitingKinds]));
  if (!userIds.length) return kinds;
  const ws = ctx.scope.workspaceId!;
  const [sent, needed] = await Promise.all([
    rows<{
      user_id: string;
      replies: number;
      replied_at: Date | string | null;
      messages: number;
      messaged_at: Date | string | null;
    }>(
      ctx.tx,
      sql`select user_id,
            count(*) filter (where handed_over)::int as replies,
            max(created_at) filter (where handed_over) as replied_at,
            count(*) filter (where not handed_over)::int as messages,
            max(created_at) filter (where not handed_over) as messaged_at
          from addon_outreach.sends
          where workspace_id = ${ws} and state = 'waiting' and user_id = any (${ids(userIds)}::uuid[])
          group by user_id`,
    ),
    // A need names who and why: a colleague's are counted on the database, never read (decision 41).
    rows<{ user_id: string; n: number; newest: Date | string | null }>(
      ctx.tx,
      sql`select user_id, n, newest
          from private.outreach_needs_waiting(${ws}::uuid, ${ids(userIds)}::uuid[], ${shownSince(now)}::timestamptz)`,
    ),
  ]);
  for (const s of sent) {
    const k = kinds.get(s.user_id)!;
    k.reply = { count: s.replies, newestAt: iso(s.replied_at) };
    k.message = { count: s.messages, newestAt: iso(s.messaged_at) };
  }
  for (const n of needed) kinds.get(n.user_id)!.need = { count: n.n, newestAt: iso(n.newest) };
  for (const [userId, counted] of (await asksNeedingYou(ctx, userIds, now)).counts)
    kinds.get(userId)!.ask = counted;
  return kinds;
}

/**
 * How each person has the requests they get answered on each network (decisions 121 and 136): as they picked there, or
 * as the business starts everyone until they pick. Where the extension doesn't answer them, the good fits are Today's
 * for the person to confirm, as decision 30 has it.
 */
async function requestModes(
  ctx: Ctx,
): Promise<(userId: string, platform: Platform) => RequestMode> {
  const everyone = await everyoneAutomation(ctx);
  return (userId, platform) =>
    answersRequests(platform)
      ? requestModeOf(choicesFor(everyone.of(userId, platform).settings, platform))
      : 'fits';
}

/**
 * Each person's friend requests to decide, the newest first: those they got in the last two weeks, not set aside
 * since they asked nor pressed Confirm or Delete on, that aren't to be confirmed or deleted as they picked and the AI
 * says (decisions 30, 121 and 136, `requestAnswerOf`); with why. One the AI is still to read stays off for a day
 * (`REQUEST_READ_DAYS`), then shows saying so. One it would delete that's never deleted (in Contacts, kept, chatted
 * with, a partner) waits here, and so does every one when there's no playbook in use to delete by. Anyone on Never
 * contact stays off: their requests are never answered.
 */
export async function requestsToDecide(
  ctx: Ctx,
  userIds: readonly string[],
  now: number,
  playbooks: readonly FitPlaybook[],
): Promise<Map<string, WaitingRequest[]>> {
  const out = new Map<string, WaitingRequest[]>(userIds.map((id) => [id, []]));
  if (!userIds.length) return out;
  const modeOf = await requestModes(ctx);
  const found = await rows<
    RequestAnswered & {
      user_id: string;
      since: Date | string;
      pitched: boolean;
      kept: boolean;
      platform: Platform;
      verdict: CheckVerdict | null;
    }
  >(
    ctx.tx,
    sql`select * from (
          select f.user_id, p.id, p.name, p.url, p.intro, p.mutual_friends, g.name as group_name, f.since,
            p.platform, (${notNever('p')}) as pitched, ${neverDeleted(sql`f.user_id`)} as kept,
            ${requestAnswerColumns}, ch.verdict,
            row_number() over (partition by f.user_id order by f.since desc) as nth
          from addon_outreach.friends f
          join addon_outreach.profiles p on p.id = f.profile_id
          left join addon_outreach.groups g on g.id = p.group_id
          left join addon_outreach.checks ch on ch.profile_id = p.id and ch.user_id = f.user_id
          where f.workspace_id = ${ctx.scope.workspaceId!} and f.user_id = any (${ids(userIds)}::uuid[])
            and f.state = 'request_received' and ${contactable('p')}
            and f.since >= ${new Date(now - REQUEST_SHOWN_DAYS * DAY).toISOString()}::timestamptz
            and not (f.set_aside_at is not null and f.set_aside_at >= f.since)
            and not (f.answer_at is not null and f.answer_at >= f.since)
        ) r where nth <= ${REQUESTS_MOST}
        order by user_id, since desc, name`,
  );
  const deletesBy = playbooks.length > 0;
  for (const userId of userIds) {
    const theirs = found.filter((r) => r.user_id === userId);
    if (!theirs.length) continue;
    const shown: WaitingRequest[] = [];
    for (const r of theirs) {
      const fit = requestFit(playbooks, r);
      const answering = answersRequests(r.platform);
      const mode = modeOf(userId, r.platform);
      // The AI reads them while it decides, or helps the person decide (decision 136).
      const reads = answering && readsRequests(mode) && r.pitched;
      const said = reads ? r.said : null;
      const answer = requestAnswerOf({
        mode,
        pressed: null,
        pitched: r.pitched,
        playbooks: deletesBy,
        said,
        good: fit.level === 'good',
      });
      // Today's to confirm (if not today, then on a later day), or deleted once a day: never the person's.
      if (answer === 'confirm' || (answer === 'delete' && !r.kept)) continue;
      // Not read yet: it waits off the list a day for the AI, with a playbook in use; with none, as before.
      const read: RequestRead = !reads
        ? 'off'
        : said
          ? 'read'
          : r.verdict === 'failed'
            ? 'failed'
            : deletesBy
              ? 'reading'
              : 'off';
      if (read === 'reading' && new Date(r.since).getTime() > now - REQUEST_READ_DAYS * DAY)
        continue;
      // A good fit waits here only when nothing else held it: no playbook in use, or Don't pitch.
      const held: RequestHeld | null =
        read !== 'off' || fit.level !== 'good' || (r.pitched && deletesBy)
          ? null
          : !deletesBy
            ? 'no_playbook'
            : 'dont_pitch';
      const kept: RequestKept | null =
        said !== 'delete' || mode !== 'fits_delete'
          ? null
          : r.kept
            ? 'never'
            : !deletesBy
              ? 'no_playbook'
              : null;
      shown.push({
        profileId: r.id,
        name: r.name,
        url: r.url,
        fit: fit.level,
        why: requestWhy(fit.reasons, fit.level, held, {
          read,
          said,
          why: r.said_why,
          kept,
        }),
        held,
        since: new Date(r.since).toISOString(),
        mutualFriends: r.mutual_friends,
        said,
      });
    }
    out.set(userId, shown);
  }
  return out;
}

/** How many of each kind wait for each person. */
async function kindsFor(
  ctx: Ctx,
  userIds: readonly string[],
  now: number,
  playbooks: readonly FitPlaybook[],
): Promise<{ kinds: Map<string, WaitingKinds>; requests: Map<string, WaitingRequest[]> }> {
  const [kinds, requests] = await Promise.all([
    sendAndNeedKinds(ctx, userIds, now),
    requestsToDecide(ctx, userIds, now, playbooks),
  ]);
  for (const [userId, list] of requests)
    kinds.get(userId)!.request = { count: list.length, newestAt: list[0]?.since ?? null };
  return { kinds, requests };
}

/**
 * Everything waiting for each person, counted as their Waiting for you counts it: the Live tab, the team view, the
 * extension's icon and the pushes all say this number.
 */
export async function waitingFor(
  ctx: Ctx,
  userIds: readonly string[],
  now = Date.now(),
): Promise<Map<string, number>> {
  const { kinds } = await kindsFor(ctx, userIds, now, await playbooksInUse(ctx));
  return new Map([...kinds].map(([userId, k]) => [userId, waitingCount(k)]));
}

/**
 * The person's needs shown, the latest first, with a message's words and chat; each on its profile's network, linked
 * there: one kept with no link (before every network's were kept), or with one on another network (a chat's, kept as
 * Messenger's whatever the network), links to their page there.
 */
async function neededOf(
  ctx: Ctx,
  me: string,
  now: number,
): Promise<{ at: string; need: WaitingNeed }[]> {
  const found = await rows<{
    id: string;
    step: WaitingNeed['step'];
    profile_id: string;
    post_id: string | null;
    send_id: string | null;
    name: string;
    url: string | null;
    why: string;
    seen_at: Date | string;
    created_at: Date | string;
    text: string | null;
    thread_key: string | null;
    platform: Platform;
    profile_url: string;
  }>(
    ctx.tx,
    sql`select n.id, n.step, n.profile_id, n.post_id, n.send_id, n.name, n.url, n.why, n.seen_at, n.created_at,
          s.text, s.thread_key, p.platform, p.url as profile_url
        from addon_outreach.needs n
        join addon_outreach.profiles p on p.workspace_id = n.workspace_id and p.id = n.profile_id
        left join addon_outreach.sends s on s.id = n.send_id
        where n.workspace_id = ${ctx.scope.workspaceId!} and n.user_id = ${me} and n.state = 'open'
          and private.outreach_need_shown(n.workspace_id, n.user_id, n.profile_id, n.step, n.state, n.seen_at,
            ${shownSince(now)}::timestamptz)
        order by n.seen_at desc, n.id
        limit ${WAITING_SHOWN_MOST}`,
  );
  return found.map((n) => ({
    at: new Date(n.created_at).toISOString(),
    need: {
      needId: n.id,
      step: n.step,
      profileId: n.profile_id,
      postId: n.post_id,
      sendId: n.send_id,
      platform: n.platform,
      name: n.name,
      url: needUrlOf(n.platform, n.url, n.profile_url),
      why: n.why,
      // A message's words, or a comment's the extension couldn't post (decision 92): the person's to send.
      text: n.step === 'message' || n.step === 'comment' ? n.text : null,
      threadKey: n.step === 'message' ? n.thread_key : null,
      seenAt: new Date(n.seen_at).toISOString(),
    },
  }));
}

export const waiting = defineAddonQuery(outreachAddon, {
  name: 'outreach.waiting',
  description:
    'Everything waiting for the person, in one list: replies handed over to them, messages the extension drafted that wait for their OK, steps it couldn’t do and needs them for, and friend requests that are theirs to decide; with how many of each, their training wheels, and how their phone hears of it.',
  input: WaitingInput,
  output: WaitingOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_waiting',
    keywords: ['waiting for you', 'needs me', 'replies handed over', 'friend requests to decide'],
  },
  // The worker asks on a person's behalf, for the pushes about what waits (decision 40).
  actors: ['human', 'system'],
  scope: inWorkspace,
  async handler(ctx, input) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has things waiting for them.');
    const now = Date.now();
    const playbooks = await playbooksInUse(ctx);
    const [{ kinds, requests }, auto, timezone] = await Promise.all([
      kindsFor(ctx, [me], now, playbooks),
      automationOf(ctx, me, now),
      workspaceTimezone(ctx.tx, ctx.scope.workspaceId!),
    ]);
    const counted = kinds.get(me)!;
    const items: WaitingItem[] = [];
    const commentHolds: Platform[] = [];
    if (input.items) {
      const [waitingSends, needed, asked] = await Promise.all([
        listed(ctx, and(mine(ctx, me), eq(sends.state, 'waiting'))),
        neededOf(ctx, me, now),
        asksNeedingYou(ctx, [me], now, me),
      ]);
      for (const ask of asked.items)
        items.push({ kind: 'ask', at: ask.startedAt ?? ask.askedAt, ask });
      for (const send of waitingSends.filter((s) => s.handedOver))
        items.push({ kind: 'reply', at: send.createdAt, send });
      for (const send of waitingSends.filter((s) => !s.handedOver))
        items.push({ kind: 'message', at: send.createdAt, send });
      // While a comment or a reply in a group waits, each network whose comments wait under the comments-only hold
      // now, for its note (decisions 92's 13 and 114): the screens match each comment to its own network.
      if (waitingSends.some((s) => underAPost(s.kind)))
        for (const platform of PLATFORM_KEYS)
          if (await commentHoldOf(ctx, me, platform)) commentHolds.push(platform);
      for (const { at, need } of needed) items.push({ kind: 'need', at, need });
      for (const request of (requests.get(me) ?? []).slice(0, WAITING_SHOWN_MOST))
        items.push({ kind: 'request', at: request.since, request });
    }
    return {
      count: waitingCount(counted),
      kinds: counted,
      items,
      wheels: auto.wheels,
      commentHolds,
      pushes: auto.settings.pushes,
      hours: auto.settings.hours,
      timezone,
    };
  },
});

const notWaiting = () =>
  HfosError.notFound(
    'That isn’t waiting for you any more: it was done or let go. Refresh Waiting for you.',
  );

export const needNote = defineAddonCommand(outreachAddon, {
  name: 'outreach.need.note',
  description:
    'The browser extension couldn’t do a step on the person’s list for today on one of their networks (a button or box it couldn’t find, a different page, the network not taking it): it’s handed to the person in Waiting for you, to do themselves or let go, with a link to their page (or the post) on that network. The same step again is the same one; one let go lately keeps nothing.',
  risk: 0,
  input: NeedNoteInput,
  output: NeedNoteOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  // The extension couldn't, there and then: kept whenever it arrives, at that moment.
  offline: 'anytime',
  emits: ['outreach.need.noted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const [profile] = await ctx.tx
      .select({ id: profiles.id, platform: profiles.platform, url: profiles.url })
      .from(profiles)
      .where(and(eq(profiles.workspaceId, ws), eq(profiles.id, input.profileId)));
    if (!profile)
      throw HfosError.notFound(
        'That person isn’t kept in Social Outreach any more. Refresh your list for today.',
      );
    let postUrl: string | null = null;
    if (input.postId) {
      const [post] = await ctx.tx
        .select({ id: posts.id, url: posts.url })
        .from(posts)
        .where(and(eq(posts.workspaceId, ws), eq(posts.userId, me), eq(posts.id, input.postId)));
      if (!post)
        throw HfosError.notFound(
          'That post isn’t on your list any more. Refresh your list for today.',
        );
      postUrl = post.url;
    }
    return openNeed(
      ctx,
      me,
      {
        step: input.step,
        profileId: profile.id,
        // Linked on their network: the extension's link when it's there, else the post, else their page.
        profile: { platform: profile.platform, url: profile.url },
        postId: input.postId,
        postUrl,
        name: input.name,
        url: input.url,
        why: input.why,
      },
      changeMoment(ctx.meta),
    );
  },
});

export const needClear = defineAddonCommand(outreachAddon, {
  name: 'outreach.need.clear',
  description:
    'The person did a step the extension handed to them, or let it go: it leaves Waiting for you. Let go, the same step for the same person isn’t handed over again for a week.',
  risk: 0,
  input: NeedClearInput,
  output: NeedClearOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_clear_step',
    keywords: ['I did it', 'let it go', 'step handed to me'],
  },
  scope: inWorkspace,
  // Pressed with no signal on the phone, it keeps the moment it was pressed.
  offline: 'anytime',
  emits: ['outreach.need.cleared'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const [row] = await ctx.tx
      .select()
      .from(needs)
      .where(
        and(
          eq(needs.workspaceId, ctx.scope.workspaceId!),
          eq(needs.userId, me),
          eq(needs.id, input.needId),
        ),
      );
    if (!row || row.state !== 'open') throw notWaiting();
    // The extension couldn't do it again after the person pressed: it still waits.
    if (row.seenAt > at) return { needId: row.id, state: 'open' as const };
    await ctx.tx
      .update(needs)
      .set({ state: input.how, clearedAt: at, updatedAt: new Date() })
      .where(eq(needs.id, row.id));
    await ctx.emit({
      type: 'outreach.need.cleared',
      entityType: 'outreach_need',
      entityId: row.id,
      payload: { userId: me, how: input.how, step: row.step },
    });
    return { needId: row.id, state: input.how };
  },
});

export const requestSetAside = defineAddonCommand(outreachAddon, {
  name: 'outreach.request.set_aside',
  description:
    'The person leaves a friend request they got as it is: it leaves Waiting for you until the same person asks again. Nothing changes on Facebook.',
  risk: 0,
  input: RequestSetAsideInput,
  output: RequestSetAsideOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_leave_request',
    keywords: ['leave friend request', 'set aside request'],
  },
  scope: inWorkspace,
  // Pressed with no signal on the phone, it keeps the moment it was pressed: a request that came after stays.
  offline: 'anytime',
  emits: ['outreach.request.set_aside'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta).toISOString();
    const [row] = await ctx.tx
      .update(friends)
      .set({
        setAsideAt: sql`greatest(coalesce(${friends.setAsideAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(friends.workspaceId, ctx.scope.workspaceId!),
          eq(friends.userId, me),
          eq(friends.profileId, input.profileId),
          eq(friends.state, 'request_received'),
        ),
      )
      .returning({ profileId: friends.profileId });
    if (!row)
      throw HfosError.notFound(
        'That friend request isn’t waiting any more: it was answered on Facebook. Refresh Waiting for you.',
      );
    await ctx.emit({
      type: 'outreach.request.set_aside',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { userId: me },
    });
    return { profileId: row.profileId };
  },
});

export const requestAnswer = defineAddonCommand(outreachAddon, {
  name: 'outreach.request.answer',
  description:
    'The person confirms or deletes a friend request they got (decision 136), whatever they picked for those: their computer confirms it as it works through their day, or deletes it with the once-a-day jobs, on Facebook, LinkedIn or Alignable. It leaves Waiting for you at once.',
  risk: 2,
  input: RequestAnswerInput,
  output: RequestAnswerOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_answer_request',
    autonomy: 'confirm',
    keywords: [
      'confirm friend request',
      'delete friend request',
      'accept invitation',
      'ignore invitation',
    ],
  },
  scope: inWorkspace,
  // Pressed with no signal on the phone, it keeps the moment it was pressed: a request that came after stays.
  offline: 'anytime',
  emits: ['outreach.request.answered'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const at = changeMoment(ctx.meta).toISOString();
    const [asked] = await rows<{ name: string; platform: Platform; open: boolean }>(
      ctx.tx,
      sql`select p.name, p.platform, ${contactable('p')} as open
          from addon_outreach.friends f join addon_outreach.profiles p on p.id = f.profile_id
          where f.workspace_id = ${ws} and f.user_id = ${me} and f.profile_id = ${input.profileId}
            and f.state = 'request_received'`,
    );
    if (!asked)
      throw HfosError.notFound(
        'That friend request isn’t waiting any more: it was answered already. Refresh Waiting for you.',
      );
    const network = NETWORKS[asked.platform];
    if (!answersRequests(asked.platform))
      throw HfosError.rule(
        'outreach_request_network',
        422,
        `Your computer doesn’t answer ${network.words.friendRequests} on ${network.name}. Answer ${asked.name}’s there yourself.`,
      );
    if (!asked.open)
      throw HfosError.rule(
        'outreach_never_contact',
        422,
        `${asked.name} is on Never contact, so your computer never answers their ${network.words.friendRequest}. Take them off Never contact in their menu first, or answer it on ${network.name} yourself.`,
      );
    await ctx.tx
      .update(friends)
      .set({
        answer: input.answer,
        answerAt: sql`greatest(coalesce(${friends.answerAt}, ${at}::timestamptz), ${at}::timestamptz)`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(friends.workspaceId, ws),
          eq(friends.userId, me),
          eq(friends.profileId, input.profileId),
          eq(friends.state, 'request_received'),
        ),
      );
    await ctx.emit({
      type: 'outreach.request.answered',
      entityType: 'outreach_profile',
      entityId: input.profileId,
      payload: { userId: me, answer: input.answer },
    });
    return { profileId: input.profileId, answer: input.answer };
  },
});

export const waitingCommands = [needNote, needClear, requestSetAside, requestAnswer] as const;
export const waitingQueries = [waiting] as const;
