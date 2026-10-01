/**
 * Messages in a client's portal (Real Estate round two, step 5; core). A client writes from their portal about one of
 * the records they're on (a deal); the team answers from the Inbox with message.send on channel `portal`.
 *
 * Each client has one thread per record (`portal:<person>:<record>`), assigned to the record's main person when it
 * starts. A thread on a private record is sealed with it, so only the people on that deal, owners, admins and
 * whoever sees every deal read it (Chris, 2026-09-30). The client reads their own threads under row security
 * (`portal.messages`), and what they've been shown counts as seen (`portal.mark_read`). The worker marks a person's
 * reply sent (`portal.mark_sent`), and emails the client a link to an unread one ten minutes on.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { conversations, customRecords, messages } from '@hfos/db/schema';
import { logChannelActivity } from '../crm/activities';
import { HfosError } from '../errors';
import { requireCustomer } from '../kernel/actor';
import { defineCommand, defineQuery } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { messagePreview } from '../messaging/sms';
import { scheduleJob, workspaceMessaging } from '../messaging/store';
import {
  PORTAL_MESSAGES_PER_DAY,
  PortalMarkReadInput,
  PortalMarkReadOutput,
  PortalMarkSentInput,
  PortalMarkSentOutput,
  PortalMessageSendInput,
  PortalMessageSendOutput,
  PortalMessagesInput,
  PortalMessagesOutput,
} from '../schemas/portal';

const inWorkspace = (i: { workspaceId: string }) =>
  ({ kind: 'workspace', workspaceId: i.workspaceId }) as const;

const PAGE = 50;
const notInPortal = () =>
  HfosError.notFound('That isn’t in your portal any more. Refresh the page to see what is.');

/** The thread's key: the client, and the record it's about. */
export const portalCounterpart = (personId: string, recordId: string | null): string =>
  recordId ? `portal:${personId}:${recordId}` : `portal:${personId}`;

async function onRecord(ctx: CommandContext, personId: string, recordId: string): Promise<boolean> {
  const [r] = await rows<{ ok: boolean }>(
    ctx.tx,
    sql`select ${recordId}::uuid in (
          select private.portal_records_for(${ctx.scope.workspaceId}::uuid, ${personId}::uuid)) as ok`,
  );
  return !!r?.ok;
}

/** The client's thread about this record, or a new one assigned to the record's main person. */
async function openPortalThread(
  ctx: CommandContext,
  personId: string,
  recordId: string | null,
): Promise<{ conversation: typeof conversations.$inferSelect; created: boolean }> {
  const workspaceId = ctx.scope.workspaceId!;
  // Found by whose and which record, not by its key: a merged customer keeps their threads.
  const find = () =>
    ctx.tx
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.workspaceId, workspaceId),
          eq(conversations.channel, 'portal'),
          eq(conversations.personId, personId),
          recordId
            ? eq(conversations.customRecordId, recordId)
            : isNull(conversations.customRecordId),
        ),
      )
      .orderBy(conversations.createdAt)
      .limit(1);
  const [found] = await find();
  if (found) return { conversation: found, created: false };
  const [owner] = recordId
    ? await ctx.tx
        .select({ ownerUserId: customRecords.ownerUserId })
        .from(customRecords)
        .where(eq(customRecords.id, recordId))
    : [];
  const inserted = await ctx.tx
    .insert(conversations)
    .values({
      workspaceId,
      channel: 'portal',
      counterpart: portalCounterpart(personId, recordId),
      personId,
      customRecordId: recordId,
      // The deal's main person answers it; anyone on the deal can.
      assigneeUserId: owner?.ownerUserId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { conversation: inserted[0], created: true };
  const [raced] = await find();
  if (!raced) throw HfosError.forbidden();
  return { conversation: raced, created: false };
}

export const portalMessageSend = defineCommand({
  name: 'portal.message_send',
  description:
    'A client writes to the business from their portal, about one of the records they’re on. It lands in the Inbox, with the people on that record.',
  risk: 1,
  input: PortalMessageSendInput,
  output: PortalMessageSendOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['message.received'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const ws = ctx.scope.workspaceId!;
    if (input.recordId && !(await onRecord(ctx, me.personId, input.recordId))) throw notInPortal();
    const { conversation: conv, created } = await openPortalThread(
      ctx,
      me.personId,
      input.recordId,
    );
    const [dup] = await ctx.tx
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
    if (dup) return { messageId: dup.id, conversationId: conv.id, duplicate: true };
    const [today] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.messages m join app.conversations c on c.id = m.conversation_id
          where c.workspace_id = ${ws} and c.channel = 'portal' and c.person_id = ${me.personId}
            and m.direction = 'inbound' and m.created_at > now() - interval '1 day'`,
    );
    if ((today?.n ?? 0) >= PORTAL_MESSAGES_PER_DAY)
      throw HfosError.rule(
        'too_many_messages',
        429,
        'You’ve sent a lot of messages today. Send the rest tomorrow, or call the office.',
      );
    const at = new Date();
    const messageId = randomUUID();
    const preview = messagePreview(input.body, 0);
    const eventId = await ctx.emit({
      type: 'message.received',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: me.personId,
        channel: 'portal',
        mediaCount: 0,
        keyword: null,
        reopened: conv.status !== 'open',
        recordId: input.recordId,
        newThread: created,
      },
      after: { from: 'Client portal', preview: preview.slice(0, 80) },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'portal',
      subtype: 'inbound',
      personId: me.personId,
      customRecordId: input.recordId,
      body: input.body,
      occurredAt: at,
      eventId,
      meta: { direction: 'inbound', messageId, conversationId: conv.id },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId: ws,
      conversationId: conv.id,
      channel: 'portal',
      direction: 'inbound',
      status: 'received',
      toAddresses: [],
      bodyText: input.body,
      clientId: input.clientId,
      occurredAt: at,
      activityId,
    });
    await ctx.tx
      .update(conversations)
      .set({
        lastMessageAt: at,
        lastInboundAt: at,
        lastPreview: preview,
        lastDirection: 'inbound',
        unreadCount: dsql`${conversations.unreadCount} + 1`,
        status: 'open',
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
        awaitingReplySince: dsql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conv.id));
    // The team's reminder when nobody has answered, as for a text or a chat.
    const m = await workspaceMessaging(ctx.tx, ws);
    const reminderMs = m.settings.unansweredReminderMinutes * 60_000;
    if (reminderMs > 0)
      await scheduleJob(ctx.tx, {
        kind: 'conversation.unanswered_check',
        dedupeKey: `unanswered:${conv.id}`,
        runAt: new Date(at.getTime() + reminderMs),
        payload: { conversationId: conv.id },
        workspaceId: ws,
        organizationId: m.organizationId,
      });
    return { messageId, conversationId: conv.id, duplicate: false };
  },
});

export const portalMessages = defineQuery({
  name: 'portal.messages',
  description:
    'A client’s messages with the business about one of their records, newest last, with who wrote each one from the business.',
  input: PortalMessagesInput,
  output: PortalMessagesOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  async handler(ctx, input) {
    // Row security keeps this to their own threads.
    const [conv] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.conversations
          where channel = 'portal' and custom_record_id is not distinct from ${input.recordId}::uuid
          order by created_at limit 1`,
    );
    if (!conv) return { conversationId: null, messages: [], unread: 0, hasMore: false };
    const list = await rows<{
      id: string;
      direction: 'inbound' | 'outbound';
      status: string;
      body_text: string | null;
      sent_by: string | null;
      occurred_at: Date | string;
    }>(
      ctx.tx,
      sql`select id, direction::text as direction, status::text as status, body_text, sent_by, occurred_at
          from app.messages
          where conversation_id = ${conv.id}
            ${input.before ? sql`and occurred_at < ${input.before}::timestamptz` : sql``}
          order by occurred_at desc, id desc
          limit ${PAGE + 1}`,
    );
    const page = list.slice(0, PAGE).reverse();
    const ids = [...new Set(page.map((m) => m.sent_by).filter((x): x is string => !!x))];
    const names = ids.length
      ? await rows<{ id: string; full_name: string }>(
          ctx.tx,
          sql`select id, full_name from portal.staff_names(${`{${ids.join(',')}}`}::uuid[])`,
        )
      : [];
    const nameOf = new Map(names.map((n) => [n.id, n.full_name]));
    const [unread] = await rows<{ n: number }>(
      ctx.tx,
      sql`select count(*)::int as n from app.messages
          where conversation_id = ${conv.id} and direction = 'outbound' and status in ('queued', 'sent')`,
    );
    return {
      conversationId: conv.id,
      messages: page.map((m) => ({
        id: m.id,
        fromYou: m.direction === 'inbound',
        body: m.body_text ?? '',
        at: new Date(m.occurred_at).toISOString(),
        from:
          m.direction === 'outbound' ? (m.sent_by ? (nameOf.get(m.sent_by) ?? null) : null) : null,
        seen: m.direction === 'inbound' || m.status === 'delivered' || m.status === 'read',
      })),
      unread: unread?.n ?? 0,
      hasMore: list.length > PAGE,
    };
  },
});

export const portalMarkRead = defineCommand({
  name: 'portal.mark_read',
  description:
    'A client’s portal showed the business’s messages up to this one: they count as seen, so no email about them goes out.',
  risk: 0,
  input: PortalMarkReadInput,
  output: PortalMarkReadOutput,
  permission: null,
  actors: ['customer'],
  scope: inWorkspace,
  emits: ['message.delivered'],
  async handler(ctx, input) {
    const me = requireCustomer(ctx);
    const [conv] = await ctx.tx
      .select({ id: conversations.id, recordId: conversations.customRecordId })
      .from(conversations)
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.workspaceId, ctx.scope.workspaceId!),
          eq(conversations.channel, 'portal'),
          eq(conversations.personId, me.personId),
        ),
      );
    if (!conv || (conv.recordId && !(await onRecord(ctx, me.personId, conv.recordId))))
      throw notInPortal();
    const [through] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.messages where id = ${input.throughMessageId} and conversation_id = ${conv.id}`,
    );
    if (!through) throw notInPortal();
    const marked = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.messages set status = 'delivered', sent_at = coalesce(sent_at, now()),
            delivered_at = coalesce(delivered_at, now())
          where conversation_id = ${conv.id} and channel = 'portal' and direction = 'outbound'
            and status in ('queued', 'sent')
            and created_at <= (select t.created_at from app.messages t where t.id = ${through.id})
          returning id`,
    );
    if (marked.length)
      await ctx.emit({
        type: 'message.delivered',
        entityType: 'message',
        entityId: through.id,
        payload: {
          conversationId: conv.id,
          status: 'delivered',
          messageIds: marked.map((m) => m.id),
        },
        after: { status: 'delivered', channel: 'portal', replies: marked.length },
      });
    return { marked: marked.length };
  },
});

export const portalMarkSent = defineCommand({
  name: 'portal_message.mark_sent',
  description:
    'Worker: a person’s reply in a client’s portal is there for them to read, so it’s marked sent.',
  risk: 0,
  input: PortalMarkSentInput,
  output: PortalMarkSentOutput,
  permission: null,
  actors: ['system'],
  scope: inWorkspace,
  // Its own event, not a second message.sent (which the worker answers by marking it): it refreshes the thread.
  emits: ['portal.reply_sent'],
  async handler(ctx, input) {
    const [m] = await rows<{ id: string; conversation_id: string }>(
      ctx.tx,
      sql`update app.messages set status = 'sent', sent_at = coalesce(sent_at, now())
          where id = ${input.messageId} and workspace_id = ${ctx.scope.workspaceId!}
            and channel = 'portal' and direction = 'outbound' and status = 'queued'
          returning id, conversation_id`,
    );
    if (m)
      await ctx.emit({
        type: 'portal.reply_sent',
        entityType: 'message',
        entityId: m.id,
        payload: { conversationId: m.conversation_id, status: 'sent' },
        before: { status: 'queued' },
        after: { status: 'sent', channel: 'portal' },
      });
    return { messageId: input.messageId, marked: !!m };
  },
});

export const portalMessageCommands = [portalMessageSend, portalMarkRead, portalMarkSent] as const;
export const portalMessageQueries = [portalMessages] as const;
