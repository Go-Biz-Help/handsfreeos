/**
 * Website chat for the worker's chat routes (the system actor, on the `chat_widget` channel) and the inbox.
 *
 * - The worker hashes a visitor's token and IP itself, so core never sees a raw token. A visitor has one
 *   conversation (counterpart chat:<visitor id>), made by their first message.
 * - A visitor who says who they are is linked to a customer with that phone, then that email, and that
 *   customer is never edited (anyone can type someone else's number). With no match a new customer is added.
 *   Nothing about a matched customer ever goes back to the visitor: chat.identify returns ids and flags.
 * - Ticking the texts box opts in only a customer the chat added, and never over a STOP.
 * - People who work the inbox block a visitor, and can block their network for 7 days.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { chatVisitors, chatWidgets, conversations, messages, people } from '@hfos/db/schema';
import {
  CHAT_NETWORK_BLOCK_MS,
  CHAT_PERSON_SOURCE,
  CHAT_TOKEN_GRACE_MS,
  CHAT_TOKEN_ROTATE_MS,
  CHAT_VISITOR_NAME,
} from '../chat/limits';
import {
  blockedError,
  blockOf,
  loadVisitor,
  networkBlocked,
  openVisitorConversation,
  type ChatVisitor,
} from '../chat/store';
import { logChannelActivity } from '../crm/activities';
import { formatPhone } from '../crm/phone';
import { fullName } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { translateDbError } from '../kernel/pg-errors';
import type { CommandContext } from '../kernel/types';
import { matchPersonByEmail as matchPersonByEmailIn } from '../messaging/email';
import { messagePreview } from '../messaging/sms';
import {
  isOptedOut,
  matchPersonByPhone,
  scheduleJob,
  workspaceMessaging,
} from '../messaging/store';
import {
  ChatBlockVisitorInput,
  ChatBlockVisitorOutput,
  ChatIdentifyInput,
  ChatIdentifyOutput,
  ChatMarkReadInput,
  ChatMarkReadOutput,
  ChatMarkSentInput,
  ChatMarkSentOutput,
  ChatReceiveInput,
  ChatReceiveOutput,
  ChatUnblockVisitorOutput,
  ChatVisitorRecordSeenInput,
  ChatVisitorRecordSeenOutput,
  ChatVisitorRefInput,
  ChatVisitorResumeInput,
  ChatVisitorResumeOutput,
  ChatVisitorRotateTokenInput,
  ChatVisitorRotateTokenOutput,
  ChatVisitorStartInput,
  ChatVisitorStartOutput,
} from '../schemas/chat';
import { PersonCreateInput } from '../schemas/person';
import { personCreate } from './person.create';
import { recordCallConsent } from '../messaging/call-consent';
import { recordOffersConsent } from '../messaging/offers';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const isoOf = (v: Date | string) => new Date(v).toISOString();
const visitorLabel = (v: { name: string | null }) => v.name ?? 'a website visitor';

async function requireWidget(ctx: CommandContext, widgetId: string) {
  const [w] = await ctx.tx
    .select({ id: chatWidgets.id, pausedAt: chatWidgets.pausedAt, dailyCap: chatWidgets.dailyCap })
    .from(chatWidgets)
    .where(and(eq(chatWidgets.id, widgetId), eq(chatWidgets.workspaceId, ctx.scope.workspaceId!)));
  if (!w)
    throw HfosError.notFound(
      'This chat isn’t available anymore. Refresh the page, or contact the business another way.',
    );
  return w;
}

async function refuseBlocked(ctx: CommandContext, visitorId: string): Promise<void> {
  const why = await blockOf(ctx.tx, ctx.scope.workspaceId!, visitorId);
  if (why) throw blockedError(why);
}

// ---------- visitors: the chat window's visits (the worker) ----------

export const chatVisitorStart = defineCommand({
  name: 'chat_visitor.start',
  description:
    'Worker: a new visitor opened a website chat. Keeps the hash of the token their chat window holds (never the token) and a hash of their IP.',
  risk: 1,
  input: ChatVisitorStartInput,
  output: ChatVisitorStartOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    await requireWidget(ctx, input.widgetId);
    const [row] = await rows<{ id: string }>(
      ctx.tx,
      sql`insert into app.chat_visitors (workspace_id, widget_id, token_hash, ip_hmac, last_page_path, last_seen_at)
          values (${ws}, ${input.widgetId}, decode(${input.tokenHash}, 'hex'),
            decode(${input.ipHmac ?? null}::text, 'hex'), ${input.pagePath ?? null}, now())
          returning id`,
    );
    if (!row) throw HfosError.forbidden();
    return { visitorId: row.id, blocked: await networkBlocked(ctx.tx, ws, input.ipHmac) };
  },
});

export const chatVisitorResume = defineCommand({
  name: 'chat_visitor.resume',
  description:
    'Worker: a returning visitor’s chat window showed its token (by hash). Finds them on this widget, including by the previous token for a few minutes after it changed, and notes that they’re on the site.',
  risk: 1,
  input: ChatVisitorResumeInput,
  output: ChatVisitorResumeOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const hash = sql`decode(${input.tokenHash}, 'hex')`;
    const [v] = await rows<{
      id: string;
      conversation_id: string | null;
      token_issued_at: Date | string;
      turnstile_passed_at: Date | string | null;
      via_previous: boolean;
      rotate_due: boolean;
      gave_name: boolean;
      gave_phone: boolean;
      gave_email: boolean;
    }>(
      ctx.tx,
      sql`update app.chat_visitors set last_seen_at = now(),
            last_page_path = coalesce(${input.pagePath ?? null}::text, last_page_path),
            ip_hmac = coalesce(decode(${input.ipHmac ?? null}::text, 'hex'), ip_hmac)
          where workspace_id = ${ws} and widget_id = ${input.widgetId}
            and (token_hash = ${hash} or (prev_token_hash = ${hash} and prev_token_expires_at > now()))
          returning id, conversation_id, token_issued_at, turnstile_passed_at, token_hash <> ${hash} as via_previous,
            token_issued_at < now() - ${CHAT_TOKEN_ROTATE_MS}::float8 * interval '1 millisecond' as rotate_due,
            name is not null as gave_name, phone_e164 is not null as gave_phone, email is not null as gave_email`,
    );
    if (!v) throw HfosError.rule('chat_not_found', 404, 'This chat has ended. Start a new one.');
    return {
      visitorId: v.id,
      conversationId: v.conversation_id,
      viaPreviousToken: v.via_previous,
      tokenIssuedAt: isoOf(v.token_issued_at),
      rotateDue: v.rotate_due,
      turnstilePassedAt: v.turnstile_passed_at ? isoOf(v.turnstile_passed_at) : null,
      blocked: (await blockOf(ctx.tx, ws, v.id)) !== null,
      gave: { name: v.gave_name, phone: v.gave_phone, email: v.gave_email },
    };
  },
});

export const chatVisitorRotateToken = defineCommand({
  name: 'chat_visitor.rotate_token',
  description:
    'Worker: give a visitor’s chat window a new token (by hash). The previous one keeps working for 10 minutes, so a lost response doesn’t lock them out.',
  risk: 1,
  input: ChatVisitorRotateTokenInput,
  output: ChatVisitorRotateTokenOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [r] = await rows<{ expires_at: Date | string }>(
      ctx.tx,
      sql`update app.chat_visitors set prev_token_hash = token_hash,
            prev_token_expires_at = now() + ${CHAT_TOKEN_GRACE_MS}::float8 * interval '1 millisecond',
            token_hash = decode(${input.tokenHash}, 'hex'), token_issued_at = now()
          where id = ${input.visitorId} and workspace_id = ${ctx.scope.workspaceId!}
          returning prev_token_expires_at as expires_at`,
    );
    if (!r) throw HfosError.notFound('This chat has ended. Refresh the page to start a new one.');
    return { visitorId: input.visitorId, previousExpiresAt: isoOf(r.expires_at) };
  },
});

export const chatVisitorRecordSeen = defineCommand({
  name: 'chat_visitor.record_seen',
  description:
    'Worker: a visitor’s chat window checked in ("On the site now"), from this page, and whether they just passed the invisible human check.',
  risk: 0,
  input: ChatVisitorRecordSeenInput,
  output: ChatVisitorRecordSeenOutput,
  permission: null,
  scope: inWorkspace,
  emits: [],
  actors: ['system'],
  async handler(ctx, input) {
    const [r] = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.chat_visitors set last_seen_at = now(),
            last_page_path = coalesce(${input.pagePath ?? null}::text, last_page_path),
            turnstile_passed_at = case when ${input.turnstilePassed}::boolean then now() else turnstile_passed_at end,
            ip_hmac = coalesce(decode(${input.ipHmac ?? null}::text, 'hex'), ip_hmac)
          where id = ${input.visitorId} and workspace_id = ${ctx.scope.workspaceId!}
          returning id`,
    );
    if (!r) throw HfosError.notFound('This chat has ended. Refresh the page to start a new one.');
    return { visitorId: r.id };
  },
});

// ---------- chatting ----------

/** New chats a widget has taken today, in the business's time zone, against its daily cap. */
async function assertUnderDailyCap(
  ctx: CommandContext,
  widgetId: string,
  cap: number,
  timezone: string,
): Promise<void> {
  // One new chat at a time per widget, so two at once can't both take the last place.
  await ctx.tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`chat-cap:${widgetId}`}, 0))`,
  );
  const [r] = await rows<{ n: number }>(
    ctx.tx,
    sql`select count(*)::int as n from app.chat_visitors v join app.conversations c on c.id = v.conversation_id
        where v.widget_id = ${widgetId}
          and c.created_at >= (date_trunc('day', now() at time zone ${timezone}) at time zone ${timezone})`,
  );
  if ((r?.n ?? 0) >= cap)
    throw HfosError.rule(
      'daily_cap',
      429,
      'This chat is very busy today. Try again tomorrow, or call or email the business instead.',
    );
}

export const chatReceive = defineCommand({
  name: 'chat.receive',
  description:
    'Worker: a website visitor sent a chat message. Files it in their one conversation (linked to the customer they said they are), reopens it, and starts the reply reminder. Refuses blocked visitors, a paused widget, and new chats past the widget’s daily limit.',
  risk: 1,
  input: ChatReceiveInput,
  output: ChatReceiveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.received'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const visitor = await loadVisitor(ctx.tx, ws, input.visitorId);
    if (visitor.conversationId) {
      const [dup] = await ctx.tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, visitor.conversationId),
            eq(messages.clientId, input.clientId),
          ),
        );
      if (dup)
        return {
          messageId: dup.id,
          conversationId: visitor.conversationId,
          duplicate: true,
          newChat: false,
        };
    }
    await refuseBlocked(ctx, visitor.id);
    const widget = await requireWidget(ctx, visitor.widgetId);
    if (widget.pausedAt)
      throw HfosError.rule(
        'widget_paused',
        409,
        'This chat is paused right now. Try again later, or contact the business another way.',
      );
    const m = await workspaceMessaging(ctx.tx, ws);
    if (!visitor.conversationId)
      await assertUnderDailyCap(ctx, visitor.widgetId, widget.dailyCap, m.timezone);
    const { conversation: conv, created } = await openVisitorConversation(ctx, visitor);
    const at = new Date();
    const messageId = randomUUID();
    const preview = messagePreview(input.body, 0);
    const eventId = await ctx.emit({
      type: 'message.received',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: 'chat',
        mediaCount: 0,
        keyword: null,
        reopened: conv.status !== 'open',
        visitorId: visitor.id,
        widgetId: visitor.widgetId,
        newChat: created,
        // False: the human check couldn't run, so the AI teammate leaves this message to people.
        aiReply: input.aiReply,
      },
      after: { from: visitor.name ?? CHAT_VISITOR_NAME, preview: preview.slice(0, 80) },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'chat',
      subtype: 'inbound',
      personId: conv.personId,
      body: input.body,
      occurredAt: at,
      eventId,
      meta: {
        direction: 'inbound',
        messageId,
        conversationId: conv.id,
        ...(input.pagePath ? { pagePath: input.pagePath } : {}),
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId: ws,
      conversationId: conv.id,
      channel: 'chat',
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
        unreadCount: sql`${conversations.unreadCount} + 1`,
        status: 'open',
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
        awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(conversations.id, conv.id));
    await ctx.tx
      .update(chatVisitors)
      .set({ lastSeenAt: at, ...(input.pagePath ? { lastPagePath: input.pagePath } : {}) })
      .where(eq(chatVisitors.id, visitor.id));
    const reminderMs = input.reminderAfterMs ?? m.settings.unansweredReminderMinutes * 60_000;
    if (reminderMs > 0)
      await scheduleJob(ctx.tx, {
        kind: 'conversation.unanswered_check',
        dedupeKey: `unanswered:${conv.id}`,
        runAt: new Date(at.getTime() + reminderMs),
        payload: { conversationId: conv.id },
        workspaceId: ws,
        organizationId: m.organizationId,
      });
    return { messageId, conversationId: conv.id, duplicate: false, newChat: created };
  },
});

export const chatMarkSent = defineCommand({
  name: 'chat.mark_sent',
  description:
    'Worker: a person’s website chat reply is out. The chat window shows it from the live feed as soon as it’s saved, so the worker marks it sent right after.',
  risk: 0,
  input: ChatMarkSentInput,
  output: ChatMarkSentOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  // Its own event, not a second message.sent (the worker's chat handler answers that one by marking it sent):
  // it only refreshes the inbox's open thread, live.
  emits: ['chat.reply_sent'],
  actors: ['system'],
  async handler(ctx, input) {
    const [m] = await rows<{ id: string; conversation_id: string }>(
      ctx.tx,
      sql`update app.messages set status = 'sent', sent_at = coalesce(sent_at, now())
          where id = ${input.messageId} and workspace_id = ${ctx.scope.workspaceId!}
            and channel = 'chat' and direction = 'outbound' and status = 'queued'
          returning id, conversation_id`,
    );
    if (m)
      await ctx.emit({
        type: 'chat.reply_sent',
        entityType: 'message',
        entityId: m.id,
        payload: { conversationId: m.conversation_id, status: 'sent' },
        before: { status: 'queued' },
        after: { status: 'sent', channel: 'chat' },
      });
    return { messageId: input.messageId, marked: !!m };
  },
});

export const chatMarkRead = defineCommand({
  name: 'chat.mark_read',
  description:
    'Worker: a website visitor’s chat window showed the replies up to this one. They count as seen (status delivered), so no follow-up goes out for them.',
  risk: 0,
  input: ChatMarkReadInput,
  output: ChatMarkReadOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  // A text's delivery receipt is message.delivered too: it refreshes the inbox's thread ("Seen"), live. No worker
  // handler answers it, so nothing goes out.
  emits: ['message.delivered'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const visitor = await loadVisitor(ctx.tx, ws, input.visitorId);
    if (!visitor.conversationId)
      throw HfosError.notFound('That message isn’t in this chat. Refresh the page and try again.');
    // Only their own chat: a message anywhere else is as good as missing.
    const [through] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.messages
          where id = ${input.throughMessageId} and conversation_id = ${visitor.conversationId}`,
    );
    if (!through)
      throw HfosError.notFound('That message isn’t in this chat. Refresh the page and try again.');
    const marked = await rows<{ id: string }>(
      ctx.tx,
      sql`update app.messages set status = 'delivered', sent_at = coalesce(sent_at, now()),
            delivered_at = coalesce(delivered_at, now())
          where conversation_id = ${visitor.conversationId} and channel = 'chat' and direction = 'outbound'
            and status in ('queued', 'sent')
            and created_at <= (select t.created_at from app.messages t where t.id = ${through.id})
          returning id`,
    );
    // One event for the replies the window showed (the thread refetches them all).
    if (marked.length)
      await ctx.emit({
        type: 'message.delivered',
        entityType: 'message',
        entityId: through.id,
        payload: {
          conversationId: visitor.conversationId,
          status: 'delivered',
          messageIds: marked.map((m) => m.id),
        },
        after: { status: 'delivered', channel: 'chat', replies: marked.length },
      });
    return { marked: marked.length };
  },
});

/** "Linda Park" → Linda, Park; "Mary Ann Smith" → Mary Ann, Smith; nothing typed → Website visitor. */
function splitName(name: string | null): [string, string] {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [CHAT_VISITOR_NAME, ''];
  if (parts.length === 1) return [parts[0]!.slice(0, 80), ''];
  return [parts.slice(0, -1).join(' ').slice(0, 80), parts[parts.length - 1]!.slice(0, 80)];
}

/** The customer with this email, their main one or another on file (messaging/email's lookup). */
const matchPersonByEmail = (ctx: CommandContext, email: string): Promise<string | null> =>
  matchPersonByEmailIn(ctx.tx, ctx.scope.workspaceId!, email);

/** Links the visitor's chat to the customer when it has none yet (the worker backfills its timeline). */
async function linkChat(ctx: CommandContext, visitor: ChatVisitor, personId: string) {
  if (!visitor.conversationId) return;
  const [linked] = await ctx.tx
    .update(conversations)
    .set({ personId })
    .where(and(eq(conversations.id, visitor.conversationId), isNull(conversations.personId)))
    .returning({ id: conversations.id });
  if (!linked) return;
  const [p] = await ctx.tx
    .select({ firstName: people.firstName, lastName: people.lastName })
    .from(people)
    .where(eq(people.id, personId));
  await ctx.emit({
    type: 'conversation.linked',
    entityType: 'conversation',
    entityId: linked.id,
    payload: { personId, previousPersonId: null, phoneAdded: false, auto: true },
    before: { person: null },
    after: { person: p ? fullName(p.firstName, p.lastName) : null, with: 'Website chat' },
  });
}

export const chatIdentify = defineCommand({
  name: 'chat.identify',
  description:
    'Worker: a website visitor said who they are. Keeps what they typed, and links the customer with that phone (then email) without changing them, or adds a new customer. Returns ids and flags only.',
  risk: 1,
  input: ChatIdentifyInput,
  output: ChatIdentifyOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['chat.visitor_identified', 'person.created', 'conversation.linked'],
  actors: ['system'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const visitor = await loadVisitor(ctx.tx, ws, input.visitorId);
    await refuseBlocked(ctx, visitor.id);
    // What they typed, kept on the visitor ("Said their name is …"). A blank field leaves what they gave.
    const typed = {
      name: input.name ?? visitor.name,
      phoneE164: input.phone ?? visitor.phoneE164,
      email: input.email ?? visitor.email,
    };
    const changed = (['name', 'phoneE164', 'email'] as const).filter(
      (k) => typed[k] !== visitor[k],
    );
    if (changed.length)
      await ctx.tx
        .update(chatVisitors)
        .set(Object.fromEntries(changed.map((k) => [k, typed[k]])))
        .where(eq(chatVisitors.id, visitor.id));
    let personId = visitor.personId;
    let personCreated = false;
    let smsOptedIn = false;
    let linkedNow = false;
    if (!personId && (typed.phoneE164 || typed.email)) {
      personId =
        (typed.phoneE164 ? await matchPersonByPhone(ctx.tx, ws, typed.phoneE164) : null) ??
        (typed.email ? await matchPersonByEmail(ctx, typed.email) : null);
      if (!personId) {
        const [firstName, lastName] = splitName(typed.name);
        personId = (
          await personCreate.handler(
            ctx,
            PersonCreateInput.parse({
              workspaceId: ws,
              firstName,
              lastName,
              email: typed.email,
              phone: typed.phoneE164,
              source: CHAT_PERSON_SOURCE,
              ignoreDuplicates: true,
            }),
          )
        ).personId;
        personCreated = true;
        // Ticked, a number, and never a STOP on it. A customer who was already here keeps their consent.
        const stopped = typed.phoneE164 ? await isOptedOut(ctx.tx, ws, typed.phoneE164) : false;
        if (input.smsConsent && typed.phoneE164 && !stopped) {
          await ctx.tx
            .update(people)
            .set({
              smsConsent: 'opted_in',
              smsConsentAt: new Date(),
              smsConsentSource: 'chat_widget',
            })
            .where(eq(people.id, personId));
          smsOptedIn = true;
        }
        if (input.offersConsent && typed.phoneE164 && !stopped)
          await recordOffersConsent(ctx.tx, personId, 'chat_widget');
        if (input.callConsent) await recordCallConsent(ctx.tx, ws, personId, 'Website chat');
      }
      await ctx.tx.update(chatVisitors).set({ personId }).where(eq(chatVisitors.id, visitor.id));
      linkedNow = true;
      await linkChat(ctx, visitor, personId);
    }
    await ctx.emit({
      type: 'chat.visitor_identified',
      entityType: 'chat_visitor',
      entityId: visitor.id,
      payload: {
        visitorId: visitor.id,
        conversationId: visitor.conversationId,
        personId,
        personCreated,
        linkedNow,
      },
      after: {
        name: typed.name,
        phone: typed.phoneE164 ? formatPhone(typed.phoneE164) : null,
        email: typed.email,
        linked: linkedNow,
        personCreated,
      },
    });
    return {
      visitorId: visitor.id,
      personId,
      conversationId: visitor.conversationId,
      personCreated,
      linkedNow,
      smsOptedIn,
    };
  },
});

// ---------- blocking (the inbox) ----------

export const chatBlockVisitor = defineCommand({
  name: 'chat.block_visitor',
  description:
    'Block a website chat visitor so they can’t send more messages. With `network`, everyone on their network is blocked here for 7 days too.',
  risk: 2,
  input: ChatBlockVisitorInput,
  output: ChatBlockVisitorOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['chat.visitor_blocked'],
  // The worker blocks floods too.
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const v = await loadVisitor(ctx.tx, ctx.scope.workspaceId!, input.visitorId);
    const now = Date.now();
    const networkUntil =
      v.networkBlockedUntil && v.networkBlockedUntil.getTime() > now ? v.networkBlockedUntil : null;
    const out = (blockedAt: Date, until: Date | null) => ({
      visitorId: v.id,
      blockedAt: blockedAt.toISOString(),
      networkBlockedUntil: until?.toISOString() ?? null,
    });
    if (v.blockedAt && (!input.network || networkUntil)) return out(v.blockedAt, networkUntil);
    const blockedAt = v.blockedAt ?? new Date(now);
    let until: Date | null = null;
    if (input.network) {
      const wanted = new Date(now + CHAT_NETWORK_BLOCK_MS);
      try {
        await ctx.tx.transaction((sp) =>
          sp
            .update(chatVisitors)
            .set({ blockedAt, networkBlockedUntil: wanted })
            .where(eq(chatVisitors.id, v.id)),
        );
        until = wanted;
      } catch (e) {
        // No hashed IP was ever recorded for them (the database's check), so there's no network to block.
        const t = translateDbError(e);
        if (!(t instanceof HfosError) || t.code !== 'validation') throw e;
      }
    }
    if (!until) {
      if (v.blockedAt) return out(v.blockedAt, null);
      await ctx.tx.update(chatVisitors).set({ blockedAt }).where(eq(chatVisitors.id, v.id));
    }
    await ctx.emit({
      type: 'chat.visitor_blocked',
      entityType: 'chat_visitor',
      entityId: v.id,
      payload: {
        visitorId: v.id,
        conversationId: v.conversationId,
        network: until !== null,
        networkBlockedUntil: until?.toISOString() ?? null,
      },
      before: { blocked: v.blockedAt !== null },
      after: { name: visitorLabel(v), blocked: true, network: until !== null },
    });
    return out(blockedAt, until);
  },
});

export const chatUnblockVisitor = defineCommand({
  name: 'chat.unblock_visitor',
  description:
    'Let a blocked website chat visitor chat again, lifting any block on their network that came with it.',
  risk: 1,
  input: ChatVisitorRefInput,
  output: ChatUnblockVisitorOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['chat.visitor_unblocked'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    const v = await loadVisitor(ctx.tx, ctx.scope.workspaceId!, input.visitorId);
    if (!v.blockedAt && !v.networkBlockedUntil) return { visitorId: v.id };
    await ctx.tx
      .update(chatVisitors)
      .set({ blockedAt: null, networkBlockedUntil: null })
      .where(eq(chatVisitors.id, v.id));
    await ctx.emit({
      type: 'chat.visitor_unblocked',
      entityType: 'chat_visitor',
      entityId: v.id,
      payload: { visitorId: v.id, conversationId: v.conversationId },
      before: { blocked: v.blockedAt !== null, network: v.networkBlockedUntil !== null },
      after: { name: visitorLabel(v), blocked: false },
    });
    return { visitorId: v.id };
  },
});
