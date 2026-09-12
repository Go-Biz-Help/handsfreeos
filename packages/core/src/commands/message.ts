import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sql } from '@hfos/db/client';
import {
  activities,
  conversations,
  files,
  messages,
  optOuts,
  people,
  phoneNumbers,
  type MediaRef,
} from '@hfos/db/schema';
import { logChannelActivity } from '../crm/activities';
import { formatPhone } from '../crm/phone';
import { fullName, requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { formatClock, quietHoursState } from '../messaging/quiet-hours';
import { messagePreview, smsKeyword, smsSegments } from '../messaging/sms';
import {
  findOrCreateConversation,
  isOptedOut,
  liveNumber,
  loadConversation,
  loadRegistrations,
  matchPersonByPhone,
  readiness,
  scheduleJob,
  workspaceMessaging,
} from '../messaging/store';
import {
  MessageAttachMediaInput,
  MessageAttachMediaOutput,
  MessageReceiveInput,
  MessageReceiveOutput,
  MessageRetryInput,
  MessageRetryOutput,
  MessageSendInput,
  MessageSendOutput,
  MessageUpdateStatusInput,
  MessageUpdateStatusOutput,
  PersonSetSmsConsentInput,
  PersonSetSmsConsentOutput,
} from '../schemas/message';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});

/** Types every US carrier delivers as a picture message, and the total size they accept. */
const MMS_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif']);
const MMS_MAX_BYTES = 5 * 1024 * 1024;
/** Twilio: the recipient replied STOP to this sender. */
const UNSUBSCRIBED_ERROR = '21610';

type Conversation = typeof conversations.$inferSelect;

async function resolveSmsConversation(
  ctx: CommandContext,
  input: { conversationId?: string; personId?: string; toPhone?: string },
): Promise<{ conversation: Conversation; created: boolean }> {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.conversationId) {
    const c = await loadConversation(ctx, input.conversationId);
    if (c.channel !== 'sms')
      throw HfosError.rule(
        'channel_mismatch',
        400,
        'This conversation is email. Open the customer’s texts to send a text.',
      );
    return { conversation: c, created: false };
  }
  const number = await liveNumber(ctx.tx, workspaceId);
  if (input.personId) {
    const p = await requirePerson(ctx.tx, workspaceId, input.personId);
    if (p.archivedAt)
      throw HfosError.rule('person_archived', 409, 'Restore this customer before texting them.');
    if (!p.phoneE164)
      throw HfosError.rule('no_phone', 400, 'Add a mobile number to text this customer.');
    return findOrCreateConversation(ctx, {
      channel: 'sms',
      counterpart: p.phoneE164,
      personId: p.id,
      phoneNumberId: number?.id ?? null,
    });
  }
  const to = input.toPhone!;
  return findOrCreateConversation(ctx, {
    channel: 'sms',
    counterpart: to,
    personId: await matchPersonByPhone(ctx.tx, workspaceId, to),
    phoneNumberId: number?.id ?? null,
  });
}

async function customerOptedOut(ctx: CommandContext, conv: Conversation): Promise<boolean> {
  if (await isOptedOut(ctx.tx, ctx.scope.workspaceId!, conv.counterpart)) return true;
  if (!conv.personId) return false;
  const [p] = await ctx.tx
    .select({ consent: people.smsConsent })
    .from(people)
    .where(eq(people.id, conv.personId));
  return p?.consent === 'opted_out';
}

/** The number, carrier approval, opt-out and quiet-hours checks every outbound text passes. */
async function assertCanText(
  ctx: CommandContext,
  conv: Conversation,
  opts: { acknowledgeQuietHours: boolean; skipQuietHours?: boolean },
) {
  const workspaceId = ctx.scope.workspaceId!;
  const number = await liveNumber(ctx.tx, workspaceId);
  if (!number || number.status !== 'active')
    throw HfosError.rule('no_number', 409, 'Get a business number to text customers.');
  if (!readiness(number, await loadRegistrations(ctx.tx, workspaceId)).messagingReady)
    throw HfosError.rule(
      'messaging_not_ready',
      409,
      'Texting turns on when the carriers approve your registration.',
    );
  if (await customerOptedOut(ctx, conv))
    throw HfosError.rule(
      'opted_out',
      409,
      'This customer texted STOP. They can text START to get texts again.',
    );
  if (!opts.skipQuietHours) {
    const m = await workspaceMessaging(ctx.tx, workspaceId);
    const q = quietHoursState(m.settings.quietHours, m.timezone);
    if (q.quiet && (ctx.actor.type === 'system' || !opts.acknowledgeQuietHours))
      throw new HfosError(
        'rule_violation',
        409,
        `It’s ${formatClock(q.localTime)} where the business is. Quiet hours end at ${formatClock(q.endsAt!)}.`,
        { localTime: q.localTime, endsAt: q.endsAt },
        'quiet_hours',
      );
  }
  return number;
}

async function attachmentMedia(
  ctx: CommandContext,
  fileIds: readonly string[],
): Promise<MediaRef[]> {
  if (fileIds.length === 0) return [];
  const unique = [...new Set(fileIds)];
  const list = await ctx.tx
    .select()
    .from(files)
    .where(
      and(
        eq(files.workspaceId, ctx.scope.workspaceId!),
        inArray(files.id, unique),
        isNull(files.deletedAt),
      ),
    );
  if (list.length !== unique.length || list.some((f) => f.status !== 'ready'))
    throw HfosError.validation([
      { path: 'attachmentFileIds', message: 'Attach photos that finished uploading.' },
    ]);
  if (list.some((f) => !MMS_TYPES.has(f.mimeType ?? '')))
    throw HfosError.rule('attachment_type', 400, 'Texts can carry JPG, PNG or GIF photos.');
  if (list.reduce((n, f) => n + (f.sizeBytes ?? 0), 0) > MMS_MAX_BYTES)
    throw HfosError.rule(
      'attachment_too_large',
      400,
      'The photos in one text must add up to 5 MB or less.',
    );
  const byId = new Map(list.map((f) => [f.id, f]));
  return unique.map((id) => {
    const f = byId.get(id)!;
    return {
      bucket: f.bucket,
      objectPath: f.objectPath,
      contentType: f.mimeType ?? 'application/octet-stream',
      sizeBytes: f.sizeBytes ?? 0,
      name: f.name,
      fileId: f.id,
    };
  });
}

/** Records an opt-out or opt-in for a customer number (and on the person, when there is one). */
async function setConsent(
  ctx: CommandContext,
  input: {
    counterpart: string | null;
    personId: string | null;
    optedOut: boolean;
    source: 'keyword' | 'manual' | 'carrier_error';
    keyword?: string | null;
    phoneNumberId?: string | null;
    at: Date;
  },
) {
  const workspaceId = ctx.scope.workspaceId!;
  if (input.counterpart) {
    await ctx.tx
      .insert(optOuts)
      .values({
        workspaceId,
        counterpartE164: input.counterpart,
        phoneNumberId: input.phoneNumberId ?? null,
        optedOut: input.optedOut,
        source: input.source,
        lastKeyword: input.keyword ?? null,
        optedOutAt: input.optedOut ? input.at : null,
        optedInAt: input.optedOut ? null : input.at,
        createdBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
      })
      .onConflictDoUpdate({
        target: [optOuts.workspaceId, optOuts.counterpartE164],
        set: {
          optedOut: input.optedOut,
          source: input.source,
          lastKeyword: input.keyword ?? null,
          ...(input.optedOut ? { optedOutAt: input.at } : { optedInAt: input.at }),
        },
      });
  }
  if (input.personId)
    await ctx.tx
      .update(people)
      .set({
        smsConsent: input.optedOut ? 'opted_out' : 'opted_in',
        smsConsentAt: input.at,
        smsConsentSource: input.source,
      })
      .where(eq(people.id, input.personId));
}

export const messageSend = defineCommand({
  name: 'message.send',
  description:
    'Text a customer from the business number. The message is queued here and the worker hands it to the carrier.',
  risk: 2,
  input: MessageSendInput,
  output: MessageSendOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.queued', 'conversation.created'],
  actors: ['human', 'system'],
  async handler(ctx, input) {
    if (input.channel === 'email')
      throw HfosError.rule('email_not_ready', 409, 'Email sending arrives with the email setup.');
    const workspaceId = ctx.scope.workspaceId!;
    const { conversation: conv, created } = await resolveSmsConversation(ctx, input);
    if (input.clientId) {
      const [dup] = await ctx.tx
        .select({ id: messages.id, status: messages.status })
        .from(messages)
        .where(and(eq(messages.conversationId, conv.id), eq(messages.clientId, input.clientId)));
      if (dup)
        return { messageId: dup.id, conversationId: conv.id, status: dup.status, duplicate: true };
    }
    const number = await assertCanText(ctx, conv, {
      acknowledgeQuietHours: input.acknowledgeQuietHours,
    });
    const media = await attachmentMedia(ctx, input.attachmentFileIds);
    const messageId = randomUUID();
    const now = new Date();
    const segments = smsSegments(input.body).segments;
    const preview = messagePreview(input.body, media.length);
    const to = formatPhone(conv.counterpart);
    if (created)
      await ctx.emit({
        type: 'conversation.created',
        entityType: 'conversation',
        entityId: conv.id,
        payload: { channel: 'sms', personId: conv.personId },
        after: { with: to, channel: 'sms' },
      });
    const eventId = await ctx.emit({
      type: 'message.queued',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: 'sms',
        mediaCount: media.length,
      },
      after: { to, preview: preview.slice(0, 80), segments, mediaCount: media.length },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'sms',
      subtype: 'outbound',
      personId: conv.personId,
      body: input.body,
      occurredAt: now,
      eventId,
      meta: {
        direction: 'outbound',
        messageId,
        conversationId: conv.id,
        status: 'queued',
        mediaCount: media.length,
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel: 'sms',
      direction: 'outbound',
      status: 'queued',
      fromAddress: number.e164,
      toAddresses: [conv.counterpart],
      bodyText: input.body,
      media,
      segments,
      sentBy: ctx.actor.type === 'human' ? ctx.actor.userId : null,
      clientId: input.clientId ?? null,
      occurredAt: now,
      activityId,
    });
    await ctx.tx
      .update(conversations)
      .set({
        lastMessageAt: now,
        lastOutboundAt: now,
        lastPreview: preview,
        lastDirection: 'outbound',
        awaitingReplySince: null,
        unreadCount: 0,
        status: 'open',
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
        phoneNumberId: conv.phoneNumberId ?? number.id,
      })
      .where(eq(conversations.id, conv.id));
    return { messageId, conversationId: conv.id, status: 'queued', duplicate: false };
  },
});

export const messageRetry = defineCommand({
  name: 'message.retry',
  description: 'Send a text that did not go out one more time.',
  risk: 2,
  input: MessageRetryInput,
  output: MessageRetryOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.queued'],
  async handler(ctx, input) {
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(
        and(eq(messages.id, input.messageId), eq(messages.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!m) throw HfosError.notFound('Message not found.');
    if (m.direction !== 'outbound' || (m.status !== 'failed' && m.status !== 'undelivered'))
      throw HfosError.rule(
        'message_not_failed',
        409,
        'Only a message that did not go out can be sent again.',
      );
    if (m.channel !== 'sms')
      throw HfosError.rule('email_not_ready', 409, 'Email sending arrives with the email setup.');
    const conv = await loadConversation(ctx, m.conversationId);
    await assertCanText(ctx, conv, { acknowledgeQuietHours: true, skipQuietHours: true });
    await ctx.tx
      .update(messages)
      .set({ status: 'queued', errorCode: null, errorMessage: null })
      .where(eq(messages.id, m.id));
    await ctx.emit({
      type: 'message.queued',
      entityType: 'message',
      entityId: m.id,
      payload: {
        conversationId: conv.id,
        personId: conv.personId,
        channel: m.channel,
        retry: true,
      },
      before: { status: m.status, errorCode: m.errorCode },
      after: { to: formatPhone(conv.counterpart), status: 'queued', retry: true },
    });
    return { messageId: m.id };
  },
});

export const messageReceive = defineCommand({
  name: 'message.receive',
  description:
    'Worker: a customer texted the business number. Files it in the conversation, handles STOP and START, and starts the reply reminder.',
  risk: 1,
  input: MessageReceiveInput,
  output: MessageReceiveOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.received', 'conversation.linked', 'person.opted_out', 'person.opted_in'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [dup] = await ctx.tx
      .select({ id: messages.id, conversationId: messages.conversationId })
      .from(messages)
      .where(
        and(eq(messages.workspaceId, workspaceId), eq(messages.dedupeKey, input.providerMessageId)),
      );
    if (dup)
      return {
        messageId: dup.id,
        conversationId: dup.conversationId,
        duplicate: true,
        keyword: null,
      };

    const [ours] = await ctx.tx
      .select({ id: phoneNumbers.id })
      .from(phoneNumbers)
      .where(and(eq(phoneNumbers.workspaceId, workspaceId), eq(phoneNumbers.e164, input.to)))
      .limit(1);
    const matched = await matchPersonByPhone(ctx.tx, workspaceId, input.from);
    const { conversation: conv, created } = await findOrCreateConversation(ctx, {
      channel: 'sms',
      counterpart: input.from,
      personId: matched,
      phoneNumberId: ours?.id ?? null,
    });
    const autoLink = !created && !conv.personId && !!matched;
    const personId = conv.personId ?? matched;
    const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
    const mediaCount = Math.max(input.media.length, input.mediaCount);
    const keyword = mediaCount === 0 ? smsKeyword(input.body) : null;
    const wasOut = await customerOptedOut(ctx, { ...conv, personId });
    const consentChange =
      keyword === 'stop' && !wasOut
        ? 'opted_out'
        : keyword === 'start' && wasOut
          ? 'opted_in'
          : null;
    // A STOP is not a question for the team; everything else waits for a reply.
    const needsReply = keyword !== 'stop';
    const preview = messagePreview(input.body, mediaCount);
    const messageId = randomUUID();
    const m = await workspaceMessaging(ctx.tx, workspaceId);

    const eventId = await ctx.emit({
      type: 'message.received',
      entityType: 'message',
      entityId: messageId,
      payload: {
        conversationId: conv.id,
        personId,
        channel: 'sms',
        mediaCount,
        keyword,
        reopened: conv.status !== 'open',
      },
      after: { from: formatPhone(input.from), preview: preview.slice(0, 80) },
    });
    const activityId = await logChannelActivity(ctx, {
      kind: 'sms',
      subtype: 'inbound',
      personId,
      body: input.body || preview,
      occurredAt: at,
      eventId,
      meta: {
        direction: 'inbound',
        messageId,
        conversationId: conv.id,
        mediaCount,
        ...(keyword ? { keyword } : {}),
      },
    });
    await ctx.tx.insert(messages).values({
      id: messageId,
      workspaceId,
      conversationId: conv.id,
      channel: 'sms',
      direction: 'inbound',
      status: 'received',
      fromAddress: input.from,
      toAddresses: [input.to],
      bodyText: input.body || null,
      media: input.media,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      dedupeKey: input.providerMessageId,
      segments: input.body ? smsSegments(input.body).segments : 0,
      occurredAt: at,
      activityId,
    });
    await ctx.tx
      .update(conversations)
      .set({
        lastMessageAt: at,
        lastInboundAt: at,
        lastPreview: preview || null,
        lastDirection: 'inbound',
        unreadCount: sql`${conversations.unreadCount} + 1`,
        status: 'open',
        snoozedUntil: null,
        closedAt: null,
        closedBy: null,
        ...(needsReply
          ? {
              awaitingReplySince: sql`coalesce(${conversations.awaitingReplySince}, ${at.toISOString()}::timestamptz)`,
            }
          : {}),
        ...(autoLink ? { personId } : {}),
        ...(!conv.phoneNumberId && ours ? { phoneNumberId: ours.id } : {}),
      })
      .where(eq(conversations.id, conv.id));

    if (autoLink && personId) {
      const [p] = await ctx.tx
        .select({ firstName: people.firstName, lastName: people.lastName })
        .from(people)
        .where(eq(people.id, personId));
      await ctx.emit({
        type: 'conversation.linked',
        entityType: 'conversation',
        entityId: conv.id,
        payload: { personId, previousPersonId: null, phoneAdded: false, auto: true },
        before: { person: null },
        after: {
          person: p ? fullName(p.firstName, p.lastName) : null,
          with: formatPhone(input.from),
        },
      });
    }
    if (consentChange) {
      const optedOut = consentChange === 'opted_out';
      await setConsent(ctx, {
        counterpart: input.from,
        personId,
        optedOut,
        source: 'keyword',
        keyword: input.body.trim().slice(0, 40),
        phoneNumberId: ours?.id ?? null,
        at,
      });
      await ctx.emit({
        type: optedOut ? 'person.opted_out' : 'person.opted_in',
        entityType: personId ? 'person' : 'conversation',
        entityId: personId ?? conv.id,
        payload: { conversationId: conv.id, source: 'keyword', keyword },
        after: { number: formatPhone(input.from), smsConsent: consentChange },
      });
    }
    if (needsReply && m.settings.unansweredReminderMinutes > 0)
      await scheduleJob(ctx.tx, {
        kind: 'conversation.unanswered_check',
        dedupeKey: `unanswered:${conv.id}`,
        runAt: new Date(at.getTime() + m.settings.unansweredReminderMinutes * 60_000),
        payload: { conversationId: conv.id },
        workspaceId,
        organizationId: m.organizationId,
      });
    return { messageId, conversationId: conv.id, duplicate: false, keyword };
  },
});

export const messageUpdateStatus = defineCommand({
  name: 'message.update_status',
  description: 'Worker: the carrier reported where a text is (sent, delivered or failed).',
  risk: 1,
  input: MessageUpdateStatusInput,
  output: MessageUpdateStatusOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.sent', 'message.delivered', 'message.failed', 'person.opted_out'],
  actors: ['system'],
  async handler(ctx, input) {
    const workspaceId = ctx.scope.workspaceId!;
    const [m] = input.messageId
      ? await ctx.tx
          .select()
          .from(messages)
          .where(and(eq(messages.id, input.messageId), eq(messages.workspaceId, workspaceId)))
      : await ctx.tx
          .select()
          .from(messages)
          .where(
            and(
              eq(messages.workspaceId, workspaceId),
              eq(messages.providerMessageId, input.providerMessageId!),
            ),
          )
          .limit(1);
    if (!m) throw HfosError.notFound('Message not found.');
    if (m.direction !== 'outbound')
      throw HfosError.rule(
        'message_status_transition',
        409,
        'Received messages keep their status.',
      );
    const now = new Date();
    const patch: Partial<typeof messages.$inferInsert> = { status: input.status };
    if (input.errorCode !== undefined) patch.errorCode = input.errorCode;
    if (input.errorMessage !== undefined) patch.errorMessage = input.errorMessage;
    if (input.segments !== undefined) patch.segments = input.segments;
    if (input.messageId && input.providerMessageId && !m.providerMessageId) {
      patch.providerMessageId = input.providerMessageId;
      if (!m.dedupeKey) patch.dedupeKey = input.providerMessageId;
    }
    if ((input.status === 'sent' || input.status === 'delivered') && !m.sentAt) patch.sentAt = now;
    if (input.status === 'delivered' && !m.deliveredAt) patch.deliveredAt = now;
    const [after] = await ctx.tx
      .update(messages)
      .set(patch)
      .where(eq(messages.id, m.id))
      .returning({ status: messages.status });
    const status = after?.status ?? m.status;
    const changed = status !== m.status;
    if (changed) {
      const failed = status === 'failed' || status === 'undelivered';
      const type =
        status === 'delivered'
          ? 'message.delivered'
          : failed
            ? 'message.failed'
            : status === 'sent'
              ? 'message.sent'
              : null;
      if (type)
        await ctx.emit({
          type,
          entityType: 'message',
          entityId: m.id,
          payload: { conversationId: m.conversationId, status, errorCode: input.errorCode ?? null },
          before: { status: m.status },
          after: {
            status,
            errorCode: input.errorCode ?? null,
            errorMessage: input.errorMessage ?? null,
          },
          // "sent" is a waypoint: only the outcome refreshes open screens.
          broadcast: type !== 'message.sent',
        });
      if (m.activityId && (failed || status === 'delivered'))
        await ctx.tx
          .update(activities)
          .set({ meta: sql`${activities.meta} || ${JSON.stringify({ status })}::jsonb` })
          .where(eq(activities.id, m.activityId));
    }
    if (input.errorCode === UNSUBSCRIBED_ERROR && m.toAddresses[0]) {
      const conv = await loadConversation(ctx, m.conversationId);
      if (!(await customerOptedOut(ctx, conv))) {
        await setConsent(ctx, {
          counterpart: m.toAddresses[0],
          personId: conv.personId,
          optedOut: true,
          source: 'carrier_error',
          at: now,
        });
        await ctx.emit({
          type: 'person.opted_out',
          entityType: conv.personId ? 'person' : 'conversation',
          entityId: conv.personId ?? conv.id,
          payload: { conversationId: conv.id, source: 'carrier_error' },
          after: { number: formatPhone(m.toAddresses[0]), smsConsent: 'opted_out' },
        });
      }
    }
    return { messageId: m.id, status, changed };
  },
});

export const messageAttachMedia = defineCommand({
  name: 'message.attach_media',
  description: 'Worker: photos from a picture message were copied into HandsFreeOS storage.',
  risk: 1,
  input: MessageAttachMediaInput,
  output: MessageAttachMediaOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['message.media_attached'],
  actors: ['system'],
  async handler(ctx, input) {
    const [m] = await ctx.tx
      .select()
      .from(messages)
      .where(
        and(eq(messages.id, input.messageId), eq(messages.workspaceId, ctx.scope.workspaceId!)),
      );
    if (!m) throw HfosError.notFound('Message not found.');
    const known = new Set(m.media.map((x) => x.objectPath));
    const added = input.media.filter((x) => !known.has(x.objectPath));
    if (added.length === 0) return { messageId: m.id };
    const media = [...m.media, ...added].slice(0, 10);
    await ctx.tx.update(messages).set({ media }).where(eq(messages.id, m.id));
    await ctx.emit({
      type: 'message.media_attached',
      entityType: 'message',
      entityId: m.id,
      payload: { conversationId: m.conversationId, count: media.length },
      after: { photos: media.length },
    });
    return { messageId: m.id };
  },
});

export const personSetSmsConsent = defineCommand({
  name: 'person.set_sms_consent',
  description:
    'Record that a customer asked not to be texted (or agreed to texts again) outside of a STOP or START text.',
  risk: 1,
  input: PersonSetSmsConsentInput,
  output: PersonSetSmsConsentOutput,
  permission: 'inbox.use',
  scope: inWorkspace,
  emits: ['person.opted_out', 'person.opted_in'],
  async handler(ctx, input) {
    const person = await requirePerson(ctx.tx, ctx.scope.workspaceId!, input.personId);
    if (person.smsConsent === input.consent) return { personId: person.id, consent: input.consent };
    const optedOut = input.consent === 'opted_out';
    await setConsent(ctx, {
      counterpart: person.phoneE164,
      personId: person.id,
      optedOut,
      source: 'manual',
      at: new Date(),
    });
    await ctx.emit({
      type: optedOut ? 'person.opted_out' : 'person.opted_in',
      entityType: 'person',
      entityId: person.id,
      payload: { source: 'manual' },
      before: { smsConsent: person.smsConsent },
      after: { name: fullName(person.firstName, person.lastName), smsConsent: input.consent },
    });
    return { personId: person.id, consent: input.consent };
  },
});
