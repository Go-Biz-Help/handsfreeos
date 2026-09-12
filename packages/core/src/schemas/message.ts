import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { ListInput, UserRef } from './crm';
import { messageChannel, messageDirection, smsConsent } from './conversation';
import { e164Phone, phoneRequired } from './telephony';

/** A stored photo, recording or attachment (telephony bucket) or a customer file sent as an attachment. */
export const MediaRefSchema = z.object({
  bucket: z.string().min(1).max(63),
  objectPath: z.string().min(3).max(500),
  contentType: z.string().max(120),
  sizeBytes: z.number().int().min(0),
  name: z.string().max(200),
  fileId: uuid.optional(),
});
export type MediaRefOut = z.infer<typeof MediaRefSchema>;

export const MessageSendInput = z
  .object({
    workspaceId: uuid,
    conversationId: uuid.optional(),
    personId: uuid.optional(),
    toPhone: phoneRequired.optional(),
    channel: messageChannel.default('sms'),
    body: z.string().trim().min(1, 'Write a message.').max(10000),
    subject: z.string().trim().max(200).optional(),
    attachmentFileIds: z.array(uuid).max(10).default([]),
    /** Set by the composer so a double-clicked send lands once. */
    clientId: z.string().trim().min(1).max(64).optional(),
    /** People confirm a text during quiet hours; automations never can. */
    acknowledgeQuietHours: z.boolean().default(false),
  })
  .refine((v) => [v.conversationId, v.personId, v.toPhone].filter(Boolean).length === 1, {
    path: ['conversationId'],
    error: 'Pick one conversation, customer or number.',
  })
  .refine((v) => v.channel !== 'sms' || v.body.length <= 1600, {
    path: ['body'],
    error: 'Keep texts under 1,600 characters.',
  });
export const MessageSendOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  status: z.string(),
  duplicate: z.boolean(),
});
export const MessageRetryInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageRetryOutput = z.object({ messageId: uuid });

// ---------- worker-only (system actor) ----------
export const MessageReceiveInput = z.object({
  workspaceId: uuid,
  provider: z.enum(['twilio', 'fake']),
  providerMessageId: z.string().trim().min(2).max(200),
  from: e164Phone,
  to: e164Phone,
  body: z.string().max(10000).default(''),
  media: z.array(MediaRefSchema).max(10).default([]),
  /** Photos the provider still holds; the worker copies them and calls message.attach_media. */
  mediaCount: z.number().int().min(0).max(10).default(0),
  /** Tests and demos shorten the reply reminder; otherwise the workspace setting decides. */
  reminderAfterMs: z.number().int().min(1000).max(86_400_000).optional(),
  occurredAt: isoDateTime.optional(),
});
export const MessageReceiveOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  duplicate: z.boolean(),
  keyword: z.enum(['stop', 'start', 'help']).nullable(),
});
export const deliveryStatusUpdate = z.enum([
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
]);
export const MessageUpdateStatusInput = z
  .object({
    workspaceId: uuid,
    messageId: uuid.optional(),
    providerMessageId: z.string().trim().min(2).max(200).optional(),
    status: deliveryStatusUpdate,
    errorCode: z.string().trim().max(20).nullable().optional(),
    errorMessage: z.string().trim().max(500).nullable().optional(),
    segments: z.number().int().min(0).max(50).optional(),
  })
  .refine((v) => !!v.messageId || !!v.providerMessageId, {
    path: ['messageId'],
    error: 'Name the message.',
  });
export const MessageUpdateStatusOutput = z.object({
  messageId: uuid,
  status: z.string(),
  changed: z.boolean(),
});
export const MessageAttachMediaInput = z.object({
  workspaceId: uuid,
  messageId: uuid,
  media: z.array(MediaRefSchema).min(1).max(10),
});
export const MessageAttachMediaOutput = z.object({ messageId: uuid });

// ---------- the thread: messages and calls, newest first ----------
export const ThreadItem = z.object({
  type: z.enum(['message', 'call']),
  id: uuid,
  occurredAt: isoDateTime,
  direction: messageDirection,
  status: z.string(),
  channel: messageChannel.nullable(),
  body: z.string().nullable(),
  subject: z.string().nullable(),
  fromAddress: z.string().nullable(),
  media: z.array(MediaRefSchema),
  sentBy: UserRef,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  deliveredAt: isoDateTime.nullable(),
  durationSeconds: z.number().int().nullable(),
  isVoicemail: z.boolean(),
  hasRecording: z.boolean(),
  transcript: z.string().nullable(),
  answeredBy: UserRef,
});
export type ThreadItem = z.infer<typeof ThreadItem>;
export const ConversationThreadInput = ListInput.extend({
  workspaceId: uuid,
  conversationId: uuid,
  /** Only items after this moment (live refreshes fetch just what is new). */
  since: isoDateTime.optional(),
});
export const ConversationThreadOutput = z.object({
  items: z.array(ThreadItem),
  nextCursor: z.string().nullable(),
});
export const MessageGetInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageGetOutput = z.object({ message: ThreadItem, conversationId: uuid });

export const PersonSetSmsConsentInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  consent: z.enum(['opted_in', 'opted_out']),
});
export const PersonSetSmsConsentOutput = z.object({ personId: uuid, consent: smsConsent });
