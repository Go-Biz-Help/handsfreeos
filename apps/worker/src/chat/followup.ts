/**
 * Replies in a website chat that the visitor hasn't seen (plan M7, "Unread after 10 minutes").
 *
 * - `message.sent` on a chat (a person's reply from the inbox, the AI teammate's, or the business's own): a
 *   person's reply is marked sent (the live feed showed it the moment it was saved), and the follow-up is armed,
 *   one pending per chat.
 * - `chat.unread_followup`: once the oldest reply the visitor hasn't seen is 10 minutes old, the replies they
 *   haven't seen go out once, by email when they gave one, otherwise by text when their customer agreed to texts
 *   (and never after STOP), with a link back to the chat on the page they were on. A reply counts as seen when
 *   the chat window said so (chat.mark_read) or the visitor wrote after it. Each batch goes once: a later reply
 *   starts a new one. Texts respect quiet hours: the job waits until they end.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  addDays,
  CHAT_VISITOR_NAME,
  chatMarkSent,
  executeCommandIn,
  HfosError,
  localDateOf,
  localInstant,
  messageSend,
  scheduleJob,
  userNames,
  type RequestMeta,
} from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { conversations } from '@hfos/db/schema';
import { plainSms, STOP_WORDING } from '../booking/messages';
import type { EventHandler } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { systemActor, tenantOf, workerMeta, type TenantScope } from '../services';
import { recordSystemEvent } from '../system-event';
import { firstNameOf } from './store';

export const CHAT_JOBS = { unreadFollowUp: 'chat.unread_followup' } as const;
/** A reply the visitor hasn't seen for this long is sent to them another way. */
export const CHAT_UNREAD_AFTER_MS = 10 * 60_000;
export const unreadFollowUpKey = (conversationId: string): string =>
  `chat-unread:${conversationId}`;
/** Recorded when a batch went out; its payload's throughMessageId is the newest reply it carried. */
export const FOLLOWED_UP_EVENT = 'chat.unread_followed_up';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `message.sent`: a reply went into a website chat. */
export const onChatReplySent: EventHandler = async (ctx) => {
  const p = isRecord(ctx.event.payload) ? ctx.event.payload : {};
  const conversationId = str(p['conversationId']);
  if (p['channel'] !== 'chat' || !conversationId || !ctx.event.entityId) return;
  const scope = tenantOf(ctx.scope);
  if (p['status'] === 'queued')
    await executeCommandIn(
      ctx.tx,
      chatMarkSent,
      { workspaceId: scope.workspaceId, messageId: ctx.event.entityId },
      systemActor(scope),
      workerMeta(ctx.event.correlationId, ctx.event.id),
    );
  await scheduleJob(ctx.tx, {
    kind: CHAT_JOBS.unreadFollowUp,
    dedupeKey: unreadFollowUpKey(conversationId),
    runAt: new Date(Date.now() + CHAT_UNREAD_AFTER_MS),
    payload: { conversationId },
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
};

type Visitor = {
  id: string;
  name: string | null;
  email: string | null;
  phone_e164: string | null;
  person_id: string | null;
  last_page_path: string | null;
  blocked: boolean;
  allowed_origins: string[];
  last_seen_origin: string | null;
};

type Reply = {
  id: string;
  body_text: string | null;
  created_at: Date | string;
  sent_by: string | null;
  teammate_name: string | null;
};

async function visitorOf(tx: Tx, counterpart: string): Promise<Visitor | null> {
  const id = counterpart.startsWith('chat:') ? counterpart.slice(5) : '';
  if (!UUID_RE.test(id)) return null;
  const [v] = await rows<Visitor>(
    tx,
    sql`select v.id, v.name, v.email, v.phone_e164, v.person_id, v.last_page_path,
          v.blocked_at is not null as blocked, w.allowed_origins, w.last_seen_origin
        from app.chat_visitors v join app.chat_widgets w on w.id = v.widget_id
        where v.id = ${id}`,
  );
  return v ?? null;
}

/**
 * The replies the visitor hasn't seen: not marked seen, after their own latest message, and after the newest
 * reply an earlier follow-up carried.
 */
function unseenReplies(tx: Tx, workspaceId: string, conversationId: string): Promise<Reply[]> {
  return rows<Reply>(
    tx,
    sql`select m.id, m.body_text, m.created_at, m.sent_by, t.name as teammate_name
        from app.messages m left join app.ai_teammates t on t.id = m.sent_by_teammate_id
        where m.conversation_id = ${conversationId} and m.channel = 'chat' and m.direction = 'outbound'
          and m.status in ('queued', 'sent')
          and not exists (select 1 from app.messages i
                          where i.conversation_id = m.conversation_id and i.direction = 'inbound'
                            and i.created_at > m.created_at)
          and not exists (select 1 from app.events e
                          join app.messages d on d.id = (e.payload ->> 'throughMessageId')::uuid
                          where e.workspace_id = ${workspaceId} and e.entity_type = 'conversation'
                            and e.entity_id = ${conversationId} and e.event_type = ${FOLLOWED_UP_EVENT}
                            and (d.created_at, d.id) >= (m.created_at, m.id))
        order by m.created_at, m.id
        limit 20`,
  );
}

/** The customer the chat is linked to agreed to texts at the number the visitor typed, and never said STOP. */
async function mayText(tx: Tx, workspaceId: string, v: Visitor): Promise<boolean> {
  if (!v.person_id || !v.phone_e164) return false;
  const [p] = await rows<{ consent: string; phone: string | null; stopped: boolean }>(
    tx,
    sql`select p.sms_consent::text as consent, p.phone_e164 as phone,
          exists (select 1 from app.opt_outs o
                  where o.workspace_id = ${workspaceId} and o.counterpart_e164 = ${v.phone_e164}
                    and o.opted_out) as stopped
        from app.people p where p.id = ${v.person_id}`,
  );
  return !!p && p.consent === 'opted_in' && p.phone === v.phone_e164 && !p.stopped;
}

/** Back to the chat: the page they were on, on the widget's site, which opens the chat window (#hfos-chat). */
function chatLink(v: Visitor): string | null {
  const origin =
    v.last_seen_origin && v.allowed_origins.includes(v.last_seen_origin)
      ? v.last_seen_origin
      : v.allowed_origins[0];
  return origin ? `${origin}${v.last_page_path ?? '/'}#hfos-chat` : null;
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;

/** When quiet hours that end at `clock` (the business's time) are over, with two minutes' grace. */
function quietEnd(clock: string, timeZone: string, now: number): Date {
  const today = localDateOf(now, timeZone);
  let end = localInstant(today, clock, timeZone);
  if (end <= now) end = localInstant(addDays(today, 1), clock, timeZone);
  return new Date(end + 2 * 60_000);
}

type Sent = { readonly messageId: string } | { readonly refused: HfosError };

/** message.send as the system, in a savepoint so a refusal leaves the job's transaction usable. */
async function send(
  tx: Tx,
  scope: TenantScope,
  input: Record<string, unknown>,
  meta: RequestMeta,
): Promise<Sent> {
  try {
    const { output } = await tx.transaction((sp) =>
      executeCommandIn(sp, messageSend, input, systemActor(scope), meta),
    );
    return { messageId: output.messageId };
  } catch (e) {
    if (e instanceof HfosError) return { refused: e };
    throw e;
  }
}

/** `chat.unread_followup`: the replies a visitor hasn't seen, by email or text, once per batch. */
export const chatUnreadFollowUp: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const conversationId = String(ctx.job.payload['conversationId'] ?? '');
  return asWorker(ctx.db, scope, async (tx) => {
    const [c] = await tx
      .select({
        id: conversations.id,
        channel: conversations.channel,
        counterpart: conversations.counterpart,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!c || c.channel !== 'chat') return;
    const visitor = await visitorOf(tx, c.counterpart);
    if (!visitor || visitor.blocked) return;
    const unseen = await unseenReplies(tx, scope.workspaceId, c.id);
    if (!unseen.length) return;
    const dueAt = new Date(new Date(unseen[0]!.created_at).getTime() + CHAT_UNREAD_AFTER_MS);
    if (dueAt.getTime() > ctx.now + 250) return { rescheduleAt: dueAt };

    const [w] = await rows<{ name: string; timezone: string | null }>(
      tx,
      sql`select name, timezone from app.workspaces where id = ${scope.workspaceId}`,
    );
    const business = w?.name ?? 'The business';
    const names = await userNames(
      tx,
      unseen.flatMap((m) => (m.sent_by && !m.teammate_name ? [m.sent_by] : [])),
    );
    const replies = unseen.map((m) => ({
      who: m.teammate_name
        ? `${m.teammate_name} (AI assistant)`
        : (m.sent_by ? firstNameOf(names.get(m.sent_by)) : null) || business,
      body: m.body_text ?? '',
    }));
    const link = chatLink(visitor);
    const host = link ? new URL(link).host : null;
    const newest = unseen[unseen.length - 1]!;
    // One batch, one message: a retried job finds the one it already sent.
    const clientId = `chat-followup:${newest.id}`;
    const meta = workerMeta(null, ctx.job.id);

    let via: 'email' | 'sms' | null = null;
    let messageId: string | null = null;
    if (visitor.email) {
      const r = await send(
        tx,
        scope,
        {
          workspaceId: scope.workspaceId,
          toEmail: visitor.email,
          channel: 'email',
          subject: `${business} replied to your chat`,
          body: [
            `${business} replied to your chat${host ? ` on ${host}` : ''}:`,
            ...replies.map((r) => `${r.who}: ${r.body}`),
            link ? `Continue the chat: ${link}` : null,
          ]
            .filter(Boolean)
            .join('\n\n'),
          clientId,
          keepConversationStatus: true,
        },
        meta,
      );
      if ('messageId' in r) [via, messageId] = ['email', r.messageId];
      else ctx.log.info({ rule: r.refused.rule, conversationId }, 'chat follow-up email refused');
    }
    if (!via && (await mayText(tx, scope.workspaceId, visitor))) {
      const first = replies[0]!;
      const more = replies.length > 1 ? ` (and ${replies.length - 1} more)` : '';
      const r = await send(
        tx,
        scope,
        {
          workspaceId: scope.workspaceId,
          personId: visitor.person_id,
          channel: 'sms',
          body: plainSms(
            [
              `${business}: ${first.who} replied to your chat: "${clip(first.body, 160)}"${more}.`,
              link ? `Continue here: ${link}` : null,
              STOP_WORDING,
            ]
              .filter(Boolean)
              .join(' '),
          ),
          clientId,
          keepConversationStatus: true,
        },
        meta,
      );
      if ('messageId' in r) [via, messageId] = ['sms', r.messageId];
      else if (r.refused.rule === 'quiet_hours') {
        const endsAt = (r.refused.details as { endsAt?: unknown } | undefined)?.endsAt;
        return {
          rescheduleAt:
            typeof endsAt === 'string'
              ? quietEnd(endsAt, w?.timezone || 'UTC', ctx.now)
              : new Date(ctx.now + 30 * 60_000),
        };
      } else ctx.log.info({ rule: r.refused.rule, conversationId }, 'chat follow-up text refused');
    }
    // Nobody to tell (no email, no agreed number): nothing goes out and nothing is recorded.
    if (!via) return;
    await recordSystemEvent(tx, {
      type: FOLLOWED_UP_EVENT,
      action: CHAT_JOBS.unreadFollowUp,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      entityType: 'conversation',
      entityId: c.id,
      payload: {
        throughMessageId: newest.id,
        replies: unseen.length,
        via,
        messageId,
        _broadcast: false,
      },
      after: { with: visitor.name ?? CHAT_VISITOR_NAME, via },
      correlationId: randomUUID(),
      causationId: ctx.job.id,
    });
  });
};
