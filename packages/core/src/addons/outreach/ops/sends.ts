/**
 * Messages the extension sends on its own (../sends.ts, docs/outreach.md decisions 26 and 27), and comments on good
 * posts where a network's comments wait at first (decision 92): each drafted one waits for the person's OK or goes as
 * it is, and the extension says when it went. Each person's are their own.
 */
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { rows } from '@hfos/db/client';
import { HfosError } from '../../../errors';
import { requireHuman, userIdOf } from '../../../kernel/actor';
import type { CommandContext } from '../../../kernel/types';
import { changeMoment } from '../../../kernel/moment';
import { FRESH_MINUTES } from '../../../mobile';
import { defineAddonCommand, defineAddonQuery } from '../../server';
import { outreachAddon } from '../manifest';
import type { SendKind } from '../automation';
import { chatUrlOn } from '../network-words';
import { NETWORKS, PLATFORMS, type Platform } from '../networks';
import type { DraftOpener } from '../openers';
import {
  changed,
  COMMENT_NEEDS_YOU,
  commentHoldOn,
  goesAsItIs,
  handedOver,
  postStartOf,
  replyNeedsYou,
  SendApproveInput,
  SendApproveOutput,
  SendDoneInput,
  SendDoneOutput,
  SendQueueInput,
  SendQueueOutput,
  SENDS_MOST,
  SendSkipInput,
  SendSkipOutput,
  SendsInput,
  SendsOutput,
  type RecentMessage,
  type Send,
} from '../sends';
import { PARTNER_WORDS } from '../partners';
import { isClientSkipped, type ClientCause } from '../person-menu';
import { commentSendsOn, LINKEDIN_COMMENTS_WAIT_SINCE } from '../profile-parts';
import { OUTREACH_WORDS } from '../words';
import { fileChats, openerUses, playbooks, posts, profiles, sends } from '../tables';
import { isPartnerKind } from '../today';
import { automationOf, countWheels } from './automation';
import { noteSent, offerVersionFor } from './conversation';
import {
  chatKey,
  clientCauseOf,
  contactable,
  inWorkspace,
  isClient,
  recentOf,
  type ChatRef,
  type Ctx,
} from './common';
import { workingBuild } from './live';
import { openNeed } from './needs';
import { notePartnerSent } from './partners';
import { notePitched } from './stages';

type Row = typeof sends.$inferSelect;

const gone = () =>
  HfosError.notFound(
    'That message isn’t waiting any more: it was sent, skipped, or the person was removed. Refresh your list for today.',
  );

/** The person's sends, with who each is to and a comment's post, the oldest first. */
export async function listed(ctx: Ctx, where: ReturnType<typeof and>): Promise<Send[]> {
  const found = await ctx.tx
    .select({
      s: sends,
      name: profiles.name,
      url: profiles.url,
      postUrl: posts.url,
      postBody: posts.body,
    })
    .from(sends)
    .innerJoin(profiles, eq(profiles.id, sends.profileId))
    .leftJoin(posts, eq(posts.id, sends.postId))
    .where(where)
    .orderBy(sends.createdAt)
    .limit(SENDS_MOST);
  // Each one's chat, where it's going (the person's own: sends are only ever listed for whose they are).
  const recent = new Map<string, RecentMessage[]>();
  for (const userId of new Set(found.map(({ s }) => s.userId)))
    for (const [key, messages] of await recentOf(
      ctx,
      userId,
      found.filter(({ s }) => s.userId === userId).map(({ s }) => refOf(s)),
    ))
      recent.set(`${userId}/${key}`, messages);
  return found.map(({ s, name, url, postUrl, postBody }) => ({
    sendId: s.id,
    kind: s.kind,
    profileId: s.profileId,
    name,
    profileUrl: url,
    chatId: s.chatId,
    threadKey: s.threadKey,
    text: s.text,
    state: s.state,
    why: s.why,
    opener: s.opener,
    handedOver: s.handedOver,
    needsYou: s.needsYou,
    createdAt: s.createdAt.toISOString(),
    // A comment has no chat: its post shows above it instead.
    recent: s.kind === 'comment' ? [] : (recent.get(`${s.userId}/${chatKey(refOf(s))}`) ?? []),
    postId: s.postId,
    postUrl: s.postId ? postUrl : null,
    post: s.postId && postBody !== null ? postStartOf(postBody) : null,
  }));
}

const refOf = (s: { chatId: string | null; profileId: string }): ChatRef => ({
  chatId: s.chatId,
  profileId: s.profileId,
});

export const mine = (ctx: Ctx, me: string) =>
  and(eq(sends.workspaceId, ctx.scope.workspaceId!), eq(sends.userId, me));

/**
 * Whether a comment of the person's on a network waits for their OK under the comments-only hold (../sends.ts
 * `commentHoldOn`, decision 92's 13), from their own sends there: when the first comment was drafted, and how many
 * they OK'd themselves (one that went on its own was OK'd as it was queued). Never on a network whose comments don't
 * go through `sends`.
 */
export async function commentHoldOf(ctx: Ctx, me: string, platform: Platform): Promise<boolean> {
  if (NETWORKS[platform].commentsWait !== 'hold') return false;
  const [kept] = await rows<{ first_at: Date | string | null; okd: number }>(
    ctx.tx,
    sql`select min(s.created_at) as first_at,
          (count(*) filter (where s.approved_at > s.created_at))::int as okd
        from addon_outreach.sends s
        join addon_outreach.profiles p on p.id = s.profile_id
        where s.workspace_id = ${ctx.scope.workspaceId!} and s.user_id = ${me} and s.kind = 'comment'
          and p.platform = ${platform}`,
  );
  return commentHoldOn({
    firstAt: kept?.first_at ? new Date(kept.first_at).getTime() : null,
    okd: kept?.okd ?? 0,
    now: Date.now(),
  });
}

/**
 * A comment's post, as `outreach.send.queue` takes it (decision 92): a good post of the person's, by that profile, on
 * a network whose comments go through `sends`, not commented on and not skipped. Refused otherwise, saying which.
 */
async function commentPost(
  ctx: Ctx,
  me: string,
  profile: { readonly id: string; readonly name: string; readonly platform: Platform },
  postId: string,
): Promise<{ readonly id: string; readonly strong: boolean }> {
  const kit = NETWORKS[profile.platform];
  if (kit.commentsWait !== 'hold')
    throw HfosError.rule(
      'outreach_comment_network',
      422,
      `Comments on ${PLATFORMS[profile.platform]} aren’t kept to wait for your OK: the extension posts them as a step on Today, or you do. Update the extension if this keeps happening.`,
    );
  // LinkedIn's wait only from the build that posts them (decision 102): an older one would send it as a message.
  if (profile.platform === 'linkedin' && !commentSendsOn('linkedin', await workingBuild(ctx, me)))
    throw HfosError.rule(
      'outreach_comment_network',
      422,
      `Comments on LinkedIn wait for your OK from extension ${LINKEDIN_COMMENTS_WAIT_SINCE}, and the computer working for you has an older one or none. Update the extension on it, then try again.`,
    );
  const [post] = await rows<{
    id: string;
    profile_id: string;
    check_state: string;
    skipped: boolean;
    commented: boolean;
    strong: boolean;
  }>(
    ctx.tx,
    sql`select po.id, po.profile_id, po.check_state, po.skipped_at is not null as skipped, po.strong,
          exists (select 1 from addon_outreach.touches t
            where t.user_id = ${me} and t.kind = 'comment' and t.post_url = po.url) as commented
        from addon_outreach.posts po
        where po.workspace_id = ${ctx.scope.workspaceId!} and po.id = ${postId} and po.user_id = ${me}`,
  );
  if (!post || post.profile_id !== profile.id || post.check_state !== 'good')
    throw HfosError.rule(
      'outreach_comment_post',
      422,
      `That post isn’t a good post of ${profile.name}’s that HandsFreeOS kept for you to comment on. Refresh your list for today.`,
    );
  if (post.skipped || post.commented)
    throw HfosError.rule(
      'outreach_comment_done',
      409,
      post.commented
        ? `You commented on ${profile.name}’s post already, so no other comment goes there. Refresh your list for today.`
        : `You skipped ${profile.name}’s post, so no comment goes there. Refresh your list for today.`,
    );
  return { id: post.id, strong: post.strong };
}

/**
 * A comment closed without going (skipped, or not posted): its post is set aside, so Today never drafts it again
 * (decision 92's 16).
 */
async function setPostAside(ctx: CommandContext, row: Row, at: Date): Promise<void> {
  if (row.kind !== 'comment' || !row.postId) return;
  await ctx.tx
    .update(posts)
    .set({ skippedAt: at })
    .where(and(eq(posts.id, row.postId), isNull(posts.skippedAt)));
}

export const sendQueue = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.queue',
  description:
    'The extension drafted a message to someone on the person’s list for today: a first message, a follow-up or a reply; or, on Instagram and Alignable, a comment on a good post of theirs. It waits for the person’s OK, or, when they chose for messages to go on their own and their training wheels are off, goes as it is; a comment goes on its own once the person has OK’d 25 there and a week has gone by, and an answer to an Alignable post asking for what the business offers always waits. A message already drafted for them comes back instead. A client in Contacts gets only replies.',
  risk: 0,
  input: SendQueueInput,
  output: SendQueueOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.send.queued'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const open = () =>
      listed(
        ctx,
        and(
          mine(ctx, me),
          eq(sends.profileId, input.profileId),
          eq(sends.kind, input.kind),
          inArray(sends.state, ['waiting', 'approved']),
        ),
      );
    const [had] = await open();
    if (had) return had;
    const outreach = isClientSkipped(input.kind);
    const [profile] = await rows<{
      id: string;
      name: string;
      platform: Platform;
      off: boolean;
      client: boolean;
      client_cause: ClientCause | null;
    }>(
      ctx.tx,
      sql`select p.id, p.name, p.platform, not ${contactable('p')} as off,
            ${outreach ? isClient('p') : sql`false`} as client,
            ${outreach ? clientCauseOf('p') : sql`null`} as client_cause
          from addon_outreach.profiles p
          where p.workspace_id = ${ws} and p.id = ${input.profileId}`,
    );
    if (!profile)
      throw HfosError.notFound(
        'That person isn’t kept in Social Outreach any more. Refresh your list for today.',
      );
    // Never contact: nothing goes to them, not even a reply.
    if (profile.off)
      throw HfosError.rule(
        'outreach_never_contact',
        422,
        `${profile.name} is on the Never contact list, so no message goes to them. To write to them, take them off it in Social Outreach → People → Friends.`,
      );
    // A client gets no outreach (decision 91), only replies, and a partner's messages stay: Today never lists them, so
    // this holds whatever drafted it.
    if (profile.client)
      throw HfosError.rule(
        'outreach_client',
        422,
        OUTREACH_WORDS.person.clientNoOutreach(profile.name, profile.client_cause),
      );
    // A comment needs its post: a good one of theirs, kept for the person, on a network whose comments wait at first.
    const post =
      input.kind === 'comment' && input.postId
        ? await commentPost(ctx, me, profile, input.postId)
        : null;
    const [chat] =
      input.chatId && !post
        ? await ctx.tx
            .select({ id: fileChats.id, userId: fileChats.userId, recent: fileChats.recent })
            .from(fileChats)
            .where(and(eq(fileChats.workspaceId, ws), eq(fileChats.id, input.chatId)))
        : [];
    // The person's choices and training wheels on the network the message goes on: each network's are its own.
    const { choices: settings, wheels } = await automationOf(ctx, me, Date.now(), profile.platform);
    const at = changeMoment(ctx.meta);
    // A reply goes on its own only to what HandsFreeOS saw them write, and never to someone who needs the person.
    const theirs =
      chat?.userId === me
        ? ([...chat.recent].reverse().find((m) => !m.fromMe)?.text ?? null)
        : null;
    const partner = isPartnerKind(input.kind);
    // A partner's message waits for an OK of its own, never Approve all (decision 81), and so does an answer to a post
    // asking for what the business offers where the network keeps those apart (Alignable's forum, decision 79).
    const needsYou = partner
      ? PARTNER_WORDS.needsYou
      : post
        ? post.strong && NETWORKS[profile.platform].forumAnswersPerDay !== null
          ? COMMENT_NEEDS_YOU.answer
          : null
        : input.kind !== 'reply'
          ? null
          : theirs === null
            ? 'HandsFreeOS hasn’t seen what they wrote'
            : replyNeedsYou(theirs);
    const goes = goesAsItIs({
      sending: settings.sending,
      replies: settings.replies,
      wheels: wheels.on,
      kind: input.kind,
      simple: input.simple,
      needsYou,
      held: post ? await commentHoldOf(ctx, me, profile.platform) : false,
    });
    const handOver = handedOver({
      sending: settings.sending,
      replies: settings.replies,
      wheels: wheels.on,
      kind: input.kind,
      goes,
    });
    // Two drafts for them at once: the second finds the first.
    const [made] = await ctx.tx
      .insert(sends)
      .values({
        workspaceId: ws,
        userId: me,
        profileId: profile.id,
        kind: input.kind,
        chatId: chat?.id ?? null,
        threadKey: input.threadKey,
        text: input.text,
        drafted: input.text,
        opener: input.kind === 'opener' ? input.opener : null,
        postId: post?.id ?? null,
        state: goes ? 'approved' : 'waiting',
        approvedAt: goes ? at : null,
        // Waits for an OK of its own (Waiting for you): handed over, or to someone who needs the person.
        handedOver: handOver,
        needsYou,
        // The main offer's version it goes with: the one they were first pitched with, or the live one. A comment is
        // public, and goes with none.
        offerVersion:
          input.kind === 'reconnect' || partner || post
            ? null
            : await offerVersionFor(ctx, me, profile.id),
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: sends.id });
    if (made)
      await ctx.emit({
        type: 'outreach.send.queued',
        entityType: 'outreach_profile',
        entityId: profile.id,
        payload: {
          kind: input.kind,
          waits: !goes,
          // Whose it is: their phone hears it waits as their pushes say (the worker's waiting.ts).
          userId: me,
          // A reply the person counted on going: their phone hears why it came to them at once (the worker's alerts).
          ...(handOver ? { handOver: true, why: needsYou } : {}),
        },
      });
    const [now] = await open();
    if (!now) throw gone();
    return now;
  },
});

export const sendApprove = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.approve',
  description:
    'The person OKs messages and comments the extension drafted, as they are or changed; with none named, every one waiting (Approve all) except replies handed over to them, messages to someone who needs them and answers to Alignable posts asking for what the business offers, which wait to be OK’d one at a time. The extension sends them. On training wheels, each message counts toward coming off them; each comment counts toward the comments’ own wait.',
  risk: 1,
  input: SendApproveInput,
  output: SendApproveOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_approve_messages',
    autonomy: 'confirm',
    keywords: ['approve all', 'send messages', 'ok messages', 'approve message'],
  },
  scope: inWorkspace,
  // It reaches a prospect: an OK that waited on the phone goes by itself for 30 minutes, and asks "Still send?" after
  // (decision 44). The contract may grow it to `anytime` one day, never back.
  offline: { freshMinutes: FRESH_MINUTES },
  emits: ['outreach.send.approved'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const named = input.sends ? new Map(input.sends.map((s) => [s.sendId, s.text])) : null;
    if (named && !named.size) throw gone();
    // A reply handed over, or a message to someone who needs the person, waits for an OK of its own (`oneByOne`,
    // decisions 27 and 42): only one named alone, without `partial`, is OK'd. Approve all, named (the phone's, any
    // build) or not, passes over them, so no client can OK them in bulk.
    const alone = named?.size === 1 && !input.partial;
    const waiting: Row[] = await ctx.tx
      .select()
      .from(sends)
      .where(
        and(
          mine(ctx, me),
          eq(sends.state, 'waiting'),
          ...(named ? [inArray(sends.id, [...named.keys()])] : []),
          ...(alone ? [] : [eq(sends.handedOver, false), isNull(sends.needsYou)]),
        ),
      )
      .orderBy(sends.createdAt)
      .limit(SENDS_MOST);
    // The phone's Approve all names what it showed: those handled elsewhere since are passed over (`partial`).
    if (named && waiting.length < named.size && !input.partial) {
      const [oneOfTheirOwn] = await ctx.tx
        .select({ id: sends.id })
        .from(sends)
        .where(
          and(
            mine(ctx, me),
            eq(sends.state, 'waiting'),
            inArray(sends.id, [...named.keys()]),
            or(eq(sends.handedOver, true), isNotNull(sends.needsYou)),
          ),
        )
        .limit(1);
      if (oneOfTheirOwn)
        throw HfosError.rule(
          'outreach_send_one_by_one',
          409,
          'A reply handed over to you, a message to someone who needs you, or an answer to an Alignable post asking for what you offer, waits for an OK of its own. OK each one on its own, under Needs you on Today.',
        );
      throw gone();
    }
    const at = changeMoment(ctx.meta);
    const edits: boolean[] = [];
    for (const s of waiting) {
      const text = named?.get(s.id) ?? s.text;
      edits.push(changed(s.drafted, text));
      await ctx.tx
        .update(sends)
        .set({ text, state: 'approved', approvedAt: at, updatedAt: at })
        .where(eq(sends.id, s.id));
      await ctx.emit({
        type: 'outreach.send.approved',
        entityType: 'outreach_profile',
        entityId: s.profileId,
        payload: { kind: s.kind, changed: edits[edits.length - 1] },
      });
    }
    // Each network's training wheels count its own messages OK'd; a comment counts toward its own hold instead, from
    // `sends` (`commentHoldOf`).
    const platforms = waiting.length
      ? await ctx.tx
          .select({ id: profiles.id, platform: profiles.platform })
          .from(profiles)
          .where(inArray(profiles.id, [...new Set(waiting.map((s) => s.profileId))]))
      : [];
    const platformOf = new Map(platforms.map((p) => [p.id, p.platform]));
    const byNetwork = new Map<Platform, boolean[]>();
    waiting.forEach((s, i) => {
      if (s.kind === 'comment') return;
      const platform = platformOf.get(s.profileId) ?? 'facebook';
      byNetwork.set(platform, [...(byNetwork.get(platform) ?? []), edits[i]!]);
    });
    let wheels = null;
    for (const [platform, changes] of byNetwork) {
      const state = await countWheels(ctx, me, changes, platform);
      if (!wheels || platform === 'facebook') wheels = state;
    }
    return {
      approved: waiting.map((s) => s.id),
      wheels: wheels ?? (await countWheels(ctx, me, [])),
    };
  },
});

export const sendSkip = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.skip',
  description:
    'The person skips a message the extension drafted: it isn’t sent, and the person is off their list for today. A comment skipped sets its post aside for good.',
  risk: 0,
  input: SendSkipInput,
  output: SendSkipOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_skip_message',
    keywords: ['skip message', 'dont send'],
  },
  scope: inWorkspace,
  // It reaches nobody, so a skip made on the phone with no signal waits as long as it takes (decision 44).
  offline: 'anytime',
  emits: ['outreach.send.skipped'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    // The newer press wins: a skip that waited never undoes an OK given after it was pressed.
    const [okd] = await ctx.tx
      .select({ approvedAt: sends.approvedAt })
      .from(sends)
      .where(and(mine(ctx, me), eq(sends.id, input.sendId), eq(sends.state, 'approved')));
    if (okd?.approvedAt && okd.approvedAt > at)
      throw HfosError.rule(
        'outreach_send_okd_since',
        409,
        'You OK’d that message after you skipped it, so the OK stands and the extension sends it. To hold it, press Stop for today on the Live tab: nothing more goes out until tomorrow.',
      );
    const [row] = await ctx.tx
      .update(sends)
      .set({ state: 'skipped', doneAt: at, updatedAt: at })
      .where(
        and(
          mine(ctx, me),
          eq(sends.id, input.sendId),
          inArray(sends.state, ['waiting', 'approved']),
        ),
      )
      .returning();
    if (!row) throw gone();
    // A comment skipped stays skipped: its post isn't drafted again (decision 92's 16).
    await setPostAside(ctx, row, at);
    await ctx.emit({
      type: 'outreach.send.skipped',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { kind: row.kind },
    });
    return { sendId: row.id };
  },
});

/** The opener a first message went with (decision 23), for the results card. */
async function noteOpener(ctx: Ctx, me: string, row: Row, opener: DraftOpener) {
  const ws = ctx.scope.workspaceId!;
  const [playbook] = await ctx.tx
    .select({ id: playbooks.id })
    .from(playbooks)
    .where(and(eq(playbooks.workspaceId, ws), eq(playbooks.id, opener.playbookId)));
  if (!playbook) return;
  const use = {
    playbookId: playbook.id,
    kind: opener.kind,
    text: opener.text,
    usedAt: row.approvedAt ?? row.createdAt,
  };
  await ctx.tx
    .insert(openerUses)
    .values({ workspaceId: ws, userId: me, profileId: row.profileId, ...use })
    .onConflictDoUpdate({
      target: [openerUses.workspaceId, openerUses.userId, openerUses.profileId],
      set: use,
    });
}

export const sendDone = defineAddonCommand(outreachAddon, {
  name: 'outreach.send.done',
  description:
    'The extension sent an OK’d message in Messenger, or posted an OK’d comment, or couldn’t, and why. The message or comment itself is noted as a step, as any other. One that couldn’t go waits for the person in Waiting for you, with its words, to send themselves; a comment’s post is then set aside, so it isn’t drafted again.',
  risk: 0,
  input: SendDoneInput,
  output: SendDoneOutput,
  permission: 'outreach.use',
  scope: inWorkspace,
  emits: ['outreach.send.done', 'outreach.need.noted'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const at = changeMoment(ctx.meta);
    const state = input.sent ? ('sent' as const) : ('failed' as const);
    const [row] = await ctx.tx
      .update(sends)
      .set({ state, why: input.sent ? null : input.why, doneAt: at, updatedAt: at })
      .where(and(mine(ctx, me), eq(sends.id, input.sendId), eq(sends.state, 'approved')))
      .returning();
    if (!row) throw gone();
    if (row.kind === 'comment') {
      await commentDone(ctx, me, row, input, at);
      return { sendId: row.id, state };
    }
    if (input.sent && row.kind === 'opener' && row.opener)
      await noteOpener(ctx, me, row, row.opener);
    // A pitch that went moves them on to pitched (decision 47).
    if (input.sent && row.kind === 'pitch') await notePitched(ctx, me, row.profileId, at);
    // Where their conversation is now: a step, a follow-up, a check-in or a reply (decisions 65 to 67); a partner's
    // moves them along the Partners list instead (decision 81).
    if (input.sent && isPartnerKind(row.kind))
      await notePartnerSent(ctx, me, { profileId: row.profileId, kind: row.kind, at });
    else if (input.sent)
      await noteSent(ctx, me, {
        profileId: row.profileId,
        kind: row.kind,
        at,
        offerVersion: row.offerVersion,
      });
    // One that didn't go is the person's to send: it waits in Waiting for you with its words.
    if (!input.sent) {
      const [to] = await ctx.tx
        .select({ name: profiles.name, url: profiles.url, platform: profiles.platform })
        .from(profiles)
        .where(eq(profiles.id, row.profileId));
      if (to)
        await openNeed(
          ctx,
          me,
          {
            step: 'message',
            profileId: row.profileId,
            profile: { platform: to.platform, url: to.url },
            sendId: row.id,
            name: to.name,
            // Their chat on their own network, else their page there.
            url: chatUrlOn(to.platform, row.threadKey),
            why: input.why || 'it didn’t go',
          },
          at,
        );
    }
    await ctx.emit({
      type: 'outreach.send.done',
      entityType: 'outreach_profile',
      entityId: row.profileId,
      payload: { kind: row.kind, sent: input.sent },
    });
    return { sendId: row.id, state };
  },
});

/**
 * A comment the extension posted, or couldn't (decision 92): one posted moves nobody's conversation on, as a message's
 * does; one that didn't go sets its post aside and waits for the person in Waiting for you, with its words and its
 * post.
 */
async function commentDone(
  ctx: CommandContext,
  me: string,
  row: Row,
  input: { readonly sent: boolean; readonly why: string | null },
  at: Date,
): Promise<void> {
  if (!input.sent) {
    await setPostAside(ctx, row, at);
    const [to] = await ctx.tx
      .select({ name: profiles.name, url: profiles.url, platform: profiles.platform })
      .from(profiles)
      .where(eq(profiles.id, row.profileId));
    const [post] = row.postId
      ? await ctx.tx.select({ url: posts.url }).from(posts).where(eq(posts.id, row.postId))
      : [];
    if (to)
      await openNeed(
        ctx,
        me,
        {
          step: 'comment',
          profileId: row.profileId,
          profile: { platform: to.platform, url: to.url },
          postId: row.postId,
          postUrl: post?.url ?? null,
          sendId: row.id,
          name: to.name,
          url: post?.url ?? null,
          why: input.why || 'it didn’t go',
        },
        at,
      );
  }
  await ctx.emit({
    type: 'outreach.send.done',
    entityType: 'outreach_profile',
    entityId: row.profileId,
    payload: { kind: row.kind, sent: input.sent },
  });
}

export const sendsList = defineAddonQuery(outreachAddon, {
  name: 'outreach.sends',
  description:
    'The person’s messages and comments the extension drafted that wait for their OK, and those OK’d it’s about to send; with their training wheels.',
  input: SendsInput,
  output: SendsOutput,
  permission: 'outreach.use',
  ai: {
    tool: 'outreach_messages_to_ok',
    keywords: ['drafted messages', 'waiting for my ok', 'approve'],
  },
  scope: inWorkspace,
  async handler(ctx) {
    const me = userIdOf(ctx.actor);
    if (!me) throw HfosError.forbidden('Only a person has messages of their own to send.');
    const { wheels } = await automationOf(ctx, me);
    return {
      sends: await listed(ctx, and(mine(ctx, me), inArray(sends.state, ['waiting', 'approved']))),
      wheels,
    };
  },
});

/**
 * Today's sends for the list for today (./today.ts): those open, by profile and kind (a comment by its post), and the
 * people skipped or not sent to today, who are off the list until tomorrow (a comment's post alone). And each writer's
 * comment open, on whichever post: one at a time (decision 92's 17).
 */
export async function sendsToday(ctx: Ctx, me: string, todayFrom: string) {
  const found = await rows<{
    id: string;
    profile_id: string;
    kind: SendKind;
    post_id: string | null;
    state: Send['state'];
    text: string;
    handed_over: boolean;
    needs_you: string | null;
  }>(
    ctx.tx,
    sql`select id, profile_id, kind, post_id, state, text, handed_over, needs_you from addon_outreach.sends
        where workspace_id = ${ctx.scope.workspaceId} and user_id = ${me}
          and (state in ('waiting', 'approved')
            or (state in ('skipped', 'failed') and done_at >= ${todayFrom}::timestamptz))`,
  );
  // A comment is its post's; anything else is its person's and kind's.
  const key = (profileId: string, kind: string, postId: string | null) =>
    kind === 'comment' ? `comment:${postId}` : `${profileId}:${kind}`;
  const open = new Map<
    string,
    {
      sendId: string;
      state: 'waiting' | 'approved';
      text: string;
      handedOver: boolean;
      needsYou: string | null;
    }
  >();
  const off = new Set<string>();
  const commentOn = new Map<string, string | null>();
  for (const s of found)
    if (s.state === 'waiting' || s.state === 'approved') {
      open.set(key(s.profile_id, s.kind, s.post_id), {
        sendId: s.id,
        state: s.state,
        text: s.text,
        handedOver: s.handed_over,
        needsYou: s.needs_you,
      });
      if (s.kind === 'comment') commentOn.set(s.profile_id, s.post_id);
    } else off.add(key(s.profile_id, s.kind, s.post_id));
  return {
    open: (profileId: string | null, kind: string, postId: string | null = null) =>
      profileId ? (open.get(key(profileId, kind, postId)) ?? null) : null,
    off: (profileId: string | null, kind: string, postId: string | null = null) =>
      profileId !== null &&
      off.has(key(profileId, kind, postId)) &&
      !open.has(key(profileId, kind, postId)),
    /** The post a writer's comment open is on: undefined with none. */
    commentOn: (profileId: string | null) =>
      profileId === null ? undefined : commentOn.get(profileId),
  };
}

export const sendCommands = [sendQueue, sendApprove, sendSkip, sendDone] as const;
export const sendQueries = [sendsList] as const;
