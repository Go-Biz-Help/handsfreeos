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

/** A required email address, trimmed and lower-cased. */
export const requiredEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Enter a valid email address.' }));

export const MessageSendInput = z
  .object({
    workspaceId: uuid,
    conversationId: uuid.optional(),
    personId: uuid.optional(),
    toPhone: phoneRequired.optional(),
    toEmail: requiredEmail.optional(),
    channel: messageChannel.default('sms'),
    body: z.string().trim().min(1, 'Write a message.').max(10000),
    subject: z.string().trim().max(200).optional(),
    /** Email: copies to other people. */
    cc: z.array(requiredEmail).max(10).default([]),
    /** Email: the workspace address it goes from (otherwise the conversation's, then the default). */
    emailAddressId: uuid.optional(),
    /** Email: send through a connected Outlook or Gmail mailbox instead of a workspace address. */
    mailboxConnectionId: uuid.optional(),
    attachmentFileIds: z.array(uuid).max(10).default([]),
    /** Set by the composer so a double-clicked send lands once. */
    clientId: z.string().trim().min(1).max(64).optional(),
    /** People confirm a text during quiet hours; the system and workflows never can. */
    acknowledgeQuietHours: z.boolean().default(false),
    /**
     * HandsFreeOS's own messages (booking confirmations, reminders, workflow follow-ups): the conversation keeps
     * its status, unread count and waiting-for-reply time, and one this message starts begins closed. The
     * system and workflows only.
     */
    keepConversationStatus: z.boolean().default(false),
  })
  .refine(
    (v) => [v.conversationId, v.personId, v.toPhone, v.toEmail].filter(Boolean).length === 1,
    {
      path: ['conversationId'],
      error: 'Pick one conversation, customer, number or email address.',
    },
  )
  .refine(
    (v) =>
      v.channel === 'email' ||
      (!v.toEmail && v.cc.length === 0 && !v.emailAddressId && !v.mailboxConnectionId),
    { path: ['toEmail'], error: 'Texts go to a phone number.' },
  )
  .refine((v) => v.channel !== 'email' || !v.toPhone, {
    path: ['toPhone'],
    error: 'Email goes to an email address.',
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
  'bounced',
  'complained',
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
    /** Email: the Message-ID the provider actually used (Outlook assigns its own). */
    messageIdHeader: z.string().trim().min(3).max(998).optional(),
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
  /** The stored recording (telephony bucket), for the voicemail player. */
  recordingPath: z.string().nullable(),
  /** The voicemail's length (the call's own length includes the greeting). */
  recordingSeconds: z.number().int().nullable(),
  answeredVia: z.enum(['browser', 'forwarding']).nullable(),
  transcript: z.string().nullable(),
  answeredBy: UserRef,
  /** Email: the sanitized HTML body (received mail), the recipients, and the mailbox it went through. */
  bodyHtml: z.string().nullable(),
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  via: z.enum(['microsoft', 'google']).nullable(),
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

// ---------- email ----------
export const EmailParty = z.object({
  address: requiredEmail,
  name: z.string().trim().max(200).nullable().optional(),
});

/** Worker: an email arrived (Postmark inbound), or a connected mailbox synced one in either direction. */
export const EmailReceiveInput = z.object({
  workspaceId: uuid,
  provider: z.enum(['postmark', 'microsoft', 'google', 'fake']),
  providerMessageId: z.string().trim().min(1).max(300),
  /** Mailbox sync also brings in what the mailbox's owner sent customers from Outlook or Gmail. */
  direction: messageDirection.default('inbound'),
  messageIdHeader: z.string().trim().max(998).nullable().optional(),
  inReplyTo: z.string().trim().max(998).nullable().optional(),
  references: z.array(z.string().trim().max(998)).max(50).default([]),
  from: EmailParty,
  to: z.array(EmailParty).max(50).default([]),
  cc: z.array(EmailParty).max(50).default([]),
  subject: z.string().trim().max(998).nullable().optional(),
  bodyText: z.string().max(100_000).nullable().optional(),
  /** Already sanitized by the worker. */
  bodyHtml: z.string().max(1_000_000).nullable().optional(),
  media: z.array(MediaRefSchema).max(20).default([]),
  /** The Reply-To mailbox hash that names the conversation. */
  replyToken: z
    .string()
    .trim()
    .regex(/^[a-z2-7]{10}$/i)
    .nullable()
    .optional(),
  /** The workspace address it was sent to. */
  emailAddressId: uuid.nullable().optional(),
  mailboxConnectionId: uuid.nullable().optional(),
  providerThreadId: z.string().trim().max(300).nullable().optional(),
  occurredAt: isoDateTime.optional(),
  /** Someone claimed it from the unmatched list for this customer. */
  personId: uuid.optional(),
  /** Mailbox imports keep only mail with known customers. */
  knownOnly: z.boolean().default(false),
  /** Tests and demos shorten the reply reminder. */
  reminderAfterMs: z.number().int().min(1000).max(86_400_000).optional(),
});
export const EmailReceiveOutput = z.object({
  outcome: z.enum(['filed', 'duplicate', 'unmatched', 'skipped']),
  messageId: uuid.nullable(),
  conversationId: uuid.nullable(),
  unmatchedId: uuid.nullable(),
});

/** Worker: an address bounced for good or its owner marked an email as spam. */
export const EmailSuppressionRecordInput = z.object({
  workspaceId: uuid,
  address: requiredEmail,
  reason: z.enum(['hard_bounce', 'spam_complaint']),
  messageId: uuid.optional(),
  providerRef: z.string().trim().max(200).optional(),
  origin: z.string().trim().max(200).optional(),
});
export const EmailSuppressionRecordOutput = z.object({ suppressionId: uuid, created: z.boolean() });

export const EmailComposeOptionsInput = z
  .object({ workspaceId: uuid, conversationId: uuid.optional(), personId: uuid.optional() })
  .refine((v) => !!v.conversationId !== !!v.personId, {
    path: ['personId'],
    error: 'Pick a conversation or a customer.',
  });
export const EmailComposeOptionsOutput = z.object({
  /** The customer's address (null when they have none). */
  to: z.string().nullable(),
  conversationId: uuid.nullable(),
  canEmail: z.object({
    ok: z.boolean(),
    reason: z.enum(['no_email', 'suppressed']).nullable(),
  }),
  suppressed: z
    .object({ reason: z.enum(['hard_bounce', 'spam_complaint', 'manual']), since: isoDateTime })
    .nullable(),
  addresses: z.array(
    z.object({
      id: uuid,
      address: z.string(),
      displayName: z.string(),
      isDefault: z.boolean(),
      usable: z.boolean(),
    }),
  ),
  /** Where this email goes from unless someone picks another. */
  fromAddressId: uuid.nullable(),
  /** Connected mailboxes this person may send through. */
  mailboxes: z.array(
    z.object({
      id: uuid,
      provider: z.enum(['microsoft', 'google']),
      accountEmail: z.string().nullable(),
      displayName: z.string().nullable(),
    }),
  ),
  /** "Re: …" for a reply in this thread. */
  replySubject: z.string().nullable(),
});
