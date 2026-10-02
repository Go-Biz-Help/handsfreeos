/**
 * A customer's new message, pushed as it arrives (M10): "A customer waiting on a reply", the customerWaiting switch.
 * On `message.received` (a text, an email or a website chat), after everything else the event does:
 * - **Who:** the conversation's assignee while they still work in the business, else the people today's unanswered
 *   email picks when nobody is assigned (the business's owners and admins, and its agency's).
 * - **Not when the AI teammate has it:** the conversation is the teammate's, or the teammate is about to answer this
 *   message (its own handler queued the reply in this same transaction). People hear at its hand-off.
 * - **Not for what needs no answer, or has one:** a STOP, a booking confirmed by reply, a conversation that stays
 *   snoozed or closed, a message written long before it arrived (a mailbox catching up), or a message somebody
 *   answered before its push went (the send job looks again: `whileWaiting`).
 * - **Bursts:** the first message buzzes. More in the same conversation within 2 minutes of it, with no reply in
 *   between, replace that notification quietly with the latest words. The pending `push.burst` job is the burst:
 *   its dedupe key finds it, and it runs out on its own.
 * A customer still waiting past the reply threshold gets the urgent push as well (urgent.ts), which replaces this one.
 */
import { eq } from 'drizzle-orm';
import { messagePreview } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { replyJobKey, TEAMMATE_JOBS } from '../ai-team/constants';
import { conversationContact } from '../chat/store';
import { managers } from '../handlers/telephony';
import type { TenantScope } from '../services';
import { payloadOf, personName, pushMoment, stillHere, str } from './moment';
import { PUSH_JOBS, pushAudience, queuePush } from './queue';
import { aiCanTake, CHANNEL_WORD, conversationCollapseId } from './urgent';

type Conversation = typeof conversations.$inferSelect;

/** How long after a message's push more messages in its conversation update it quietly. */
export const BURST_MS = 2 * 60_000;
/** A message written longer ago than this when it arrives is catching up, not news for a phone. */
export const ARRIVAL_MS = 15 * 60_000;

export const burstJobKey = (conversationId: string): string => `push-burst:${conversationId}`;

/** The AI teammate's reply to this conversation is waiting to run. */
async function aiReplyWaiting(tx: Tx, conversationId: string): Promise<boolean> {
  const [job] = await rows(
    tx,
    sql`select 1 from app.scheduled_jobs
        where kind = ${TEAMMATE_JOBS.reply} and dedupe_key = ${replyJobKey(conversationId)}
          and status = 'pending'
        limit 1`,
  );
  return !!job;
}

/**
 * Whether this message joins a burst under way (its push replaces the notification quietly) or starts one (it
 * buzzes). A burst is one wait: once somebody answers, the next message starts a new one.
 */
async function joinsBurst(
  tx: Tx,
  scope: TenantScope,
  conversationId: string,
  awaitingSince: string,
): Promise<boolean> {
  const key = burstJobKey(conversationId);
  const payload = JSON.stringify({ conversationId, awaitingSince });
  const until = `${BURST_MS} milliseconds`;
  const [started] = await rows<{ id: string }>(
    tx,
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${scope.organizationId}, ${scope.workspaceId}, ${PUSH_JOBS.burst}, ${key},
          now() + ${until}::interval, ${payload}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do nothing
        returning id`,
  );
  if (started) return false;
  const [burst] = await rows<{ awaiting_since: string | null }>(
    tx,
    sql`select payload ->> 'awaitingSince' as awaiting_since from app.scheduled_jobs
        where kind = ${PUSH_JOBS.burst} and dedupe_key = ${key} and status = 'pending'`,
  );
  if (burst?.awaiting_since === awaitingSince) return true;
  // Answered since the burst began, and waiting again: this message starts a new one.
  await tx.execute(
    sql`update app.scheduled_jobs set run_at = now() + ${until}::interval, payload = ${payload}::jsonb
        where kind = ${PUSH_JOBS.burst} and dedupe_key = ${key} and status = 'pending'`,
  );
  return false;
}

/** The message's own words: an email's subject and first line, or a text's or chat's (or its photos). */
function wordsOf(
  channel: Conversation['channel'],
  m: {
    readonly body: string | null;
    readonly subject: string | null;
    readonly photos: number;
    readonly videos?: number;
  },
): string {
  if (channel !== 'email') return messagePreview(m.body, m.photos, m.videos) || 'Sent a message.';
  const firstLine = (m.body ?? '').split('\n').find((l) => l.trim()) ?? '';
  return (
    messagePreview([m.subject?.trim(), firstLine.trim()].filter(Boolean).join(' · '), m.photos) ||
    'Sent an email.'
  );
}

/** `message.received`: a customer wrote. */
export const onCustomerMessagePush = pushMoment('customerWaiting', async (ctx, scope) => {
  const messageId = ctx.event.entityId;
  const p = payloadOf(ctx);
  const conversationId = str(p['conversationId']);
  if (!messageId || !conversationId) return;
  // Nothing for the team to answer: a STOP, or a booking confirmed by reply.
  if (p['keyword'] === 'stop' || p['confirmedAttendeeIds'] !== undefined) return;
  const ws = scope.workspaceId;
  const [m] = await rows<{
    direction: string;
    occurred_at: Date | string;
    body: string | null;
    subject: string | null;
    photos: number;
    videos: number;
  }>(
    ctx.tx,
    sql`select direction::text as direction, occurred_at, body_text as body, subject,
          coalesce(jsonb_array_length(media), 0)::int as photos,
          (select count(*) from jsonb_array_elements(media) x
            where x ->> 'contentType' like 'video/%')::int as videos
        from app.messages where id = ${messageId} and workspace_id = ${ws}`,
  );
  if (!m || m.direction !== 'inbound') return;
  if (Date.now() - new Date(m.occurred_at).getTime() > ARRIVAL_MS) return;
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conv || conv.status !== 'open' || !conv.awaitingReplySince) return;
  if (conv.handledBy === 'ai' || (await aiReplyWaiting(ctx.tx, conv.id))) return;

  const assignee = conv.assigneeUserId ? await stillHere(ctx.tx, ws, [conv.assigneeUserId]) : [];
  const userIds = assignee.length ? assignee : (await managers(ctx.tx, ws)).map((u) => u.id);
  if ((await pushAudience(ctx.tx, 'customer_message', userIds)).length === 0) return;
  const awaitingSince = conv.awaitingReplySince.toISOString();
  const quiet = await joinsBurst(ctx.tx, scope, conv.id, awaitingSince);
  const customer =
    (await personName(ctx.tx, conv.personId)) ?? (await conversationContact(ctx.tx, conv));
  await queuePush(ctx.tx, scope, {
    key: `message:${messageId}`,
    category: (await aiCanTake(ctx.tx, ws, conv)) ? 'customer_message' : 'customer_message_no_ai',
    userIds,
    title: customer,
    about: CHANNEL_WORD[conv.channel] ?? null,
    body: wordsOf(conv.channel, m),
    path: `/app/w/${ws}/inbox/${conv.id}`,
    refs: {
      conversationId: conv.id,
      channel: conv.channel,
      messageId,
      ...(conv.personId ? { personId: conv.personId } : {}),
    },
    collapseId: conversationCollapseId(conv.id),
    quiet,
    whileWaiting: { conversationId: conv.id, awaitingSince },
  });
});

/**
 * `email.filed` for someone's own mail (M19): new mail in their own Inbox, pushed to them alone. The team can't see
 * the thread, so it goes to nobody else, and nothing else pushes it (its event is quiet). It rides the same switch
 * and category as a customer's message, whose Reply and Call buttons work on it and which every app build knows.
 * Their own mail never waits on a reply, so there is no burst to join: each message replaces the thread's last
 * notification.
 */
export const onOwnMailPush = pushMoment('customerWaiting', async (ctx, scope) => {
  const messageId = ctx.event.entityId;
  const p = payloadOf(ctx);
  const conversationId = str(p['conversationId']);
  if (!messageId || !conversationId) return;
  if (p['private'] !== true || p['folder'] !== 'inbox' || p['direction'] !== 'inbound') return;
  const ws = scope.workspaceId;
  const [m] = await rows<{
    occurred_at: Date | string;
    body: string | null;
    subject: string | null;
    photos: number;
  }>(
    ctx.tx,
    sql`select occurred_at, body_text as body, subject, coalesce(jsonb_array_length(media), 0)::int as photos
        from app.messages where id = ${messageId} and workspace_id = ${ws} and direction = 'inbound'`,
  );
  if (!m || Date.now() - new Date(m.occurred_at).getTime() > ARRIVAL_MS) return;
  const [conv] = await ctx.tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  // Still theirs, still in their Inbox, and not put away since.
  if (!conv?.privateTo || conv.folder !== 'inbox' || conv.status !== 'open' || conv.archivedAt)
    return;
  const userIds = await stillHere(ctx.tx, ws, [conv.privateTo]);
  if ((await pushAudience(ctx.tx, 'customer_message_no_ai', userIds)).length === 0) return;
  await queuePush(ctx.tx, scope, {
    key: `message:${messageId}`,
    category: 'customer_message_no_ai',
    userIds,
    title: await conversationContact(ctx.tx, conv),
    about: CHANNEL_WORD['email'] ?? null,
    body: wordsOf('email', m),
    path: `/app/w/${ws}/inbox/${conv.id}`,
    refs: { conversationId: conv.id, channel: 'email', messageId },
    collapseId: conversationCollapseId(conv.id),
  });
});
