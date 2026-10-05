import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { ListInput, UserRef } from './crm';
import { conversationChannel, messageDirection, smsConsent } from './conversation';
import { MediaRefSchema } from './media';
import { ButtonReplyOut, RichInput, RichTextOut, textTransport } from './rcs';
import { e164Phone, phoneRequired } from './telephony';
import { SOCIAL_TEXT_LIMITS } from '../messaging/social';

// Lives in its own module so the RCS schemas (rich texts carry pictures) can use it without importing this one.
export { MediaRefSchema, type MediaRefOut } from './media';

/** A required email address, trimmed and lower-cased. */
export const requiredEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Enter a valid email address.' }));

/**
 * What message.send can send on: a text, an email, a reply in a website chat or a customer's portal, or a reply on
 * Messenger or Instagram (20261025000200).
 */
export const sendChannel = z.enum(['sms', 'email', 'chat', 'portal', 'messenger', 'instagram']);

export const MessageSendInput = z
  .object({
    workspaceId: uuid,
    conversationId: uuid.optional(),
    personId: uuid.optional(),
    toPhone: phoneRequired.optional(),
    toEmail: requiredEmail.optional(),
    channel: sendChannel.default('sms'),
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
     * People's other answer in quiet hours ("Send at 8:00 AM"): the text waits in the conversation, shown as
     * scheduled and cancellable, and HandsFreeOS sends it when quiet hours end. Outside quiet hours it goes now.
     */
    sendAfterQuietHours: z.boolean().default(false),
    /**
     * HandsFreeOS's own messages (booking confirmations, reminders, workflow follow-ups): the conversation keeps
     * its status, unread count and waiting-for-reply time, and one this message starts begins closed. The
     * system and workflows only.
     */
    keepConversationStatus: z.boolean().default(false),
    /**
     * The answer to a customer's HELP (worker's handlers/help-reply.ts): goes whatever the hour, since the
     * customer has just asked for it. HandsFreeOS itself only.
     */
    keywordReply: z.boolean().default(false),
    /**
     * Email campaigns: the campaign email this is, so it goes with an unsubscribe link in its headers and on the
     * bulk stream. HandsFreeOS itself only.
     */
    campaignRecipientId: uuid.optional(),
    /**
     * The customer's message this answers. In quiet hours the AI teammate may text only a direct reply to the
     * latest text in the conversation, soon after it arrived.
     */
    inReplyToMessageId: uuid.optional(),
    /**
     * Texts: buttons, a card or a carousel to go with the words (0103). It goes as RCS where the customer's
     * phone can show it and as a text with the choices written out where it can't; nobody picks which.
     */
    rich: RichInput.optional(),
  })
  .refine(
    (v) => [v.conversationId, v.personId, v.toPhone, v.toEmail].filter(Boolean).length === 1,
    {
      path: ['conversationId'],
      error: 'Pick one conversation, customer, number or email address.',
    },
  )
  .refine((v) => v.channel !== 'chat' || !!v.conversationId, {
    path: ['conversationId'],
    error: 'A chat reply goes in the visitor’s chat.',
  })
  .refine((v) => v.channel !== 'portal' || !!v.conversationId, {
    path: ['conversationId'],
    error: 'A portal reply goes in the client’s portal thread.',
  })
  .refine((v) => (v.channel !== 'messenger' && v.channel !== 'instagram') || !!v.conversationId, {
    path: ['conversationId'],
    error: 'A Messenger or Instagram reply goes in the customer’s thread there.',
  })
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
  })
  .refine((v) => !(v.acknowledgeQuietHours && v.sendAfterQuietHours), {
    path: ['sendAfterQuietHours'],
    error: 'Send it now, or when quiet hours end: not both.',
  })
  .refine((v) => v.channel === 'sms' || !v.sendAfterQuietHours, {
    path: ['sendAfterQuietHours'],
    error: 'Only texts wait for quiet hours to end.',
  })
  .refine((v) => v.channel === 'sms' || !v.rich, {
    path: ['rich'],
    error: 'Buttons, cards and carousels go in texts.',
  })
  .refine((v) => v.channel !== 'messenger' || v.body.length <= SOCIAL_TEXT_LIMITS.messenger, {
    path: ['body'],
    error: 'Keep Messenger replies under 2,000 characters.',
  })
  .refine((v) => v.channel !== 'instagram' || v.body.length <= SOCIAL_TEXT_LIMITS.instagram, {
    path: ['body'],
    error: 'Keep Instagram replies under 1,000 characters.',
  });
export const MessageSendOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  status: z.string(),
  duplicate: z.boolean(),
  /** A text held until quiet hours end: when it goes. */
  scheduledFor: isoDateTime.optional(),
});
export const MessageRetryInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageRetryOutput = z.object({
  messageId: uuid,
  /** A text tried again in quiet hours waits for them to end: when it goes. */
  scheduledFor: isoDateTime.optional(),
});
/** A text waiting for quiet hours to end, cancelled: it never goes. */
export const MessageCancelScheduledInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageCancelScheduledOutput = z.object({
  messageId: uuid,
  /** False when it was cancelled already, or isn't going anyway (it didn't go). */
  changed: z.boolean(),
  /**
   * Whether it stays in the conversation. A new text leaves it; a failed text that was tried again goes back as
   * it was, not delivered, and can be tried again later.
   */
  stays: z.boolean(),
});

// ---------- worker-only (system actor) ----------
export const MessageReceiveInput = z.object({
  workspaceId: uuid,
  provider: z.enum(['twilio', 'fake']),
  providerMessageId: z.string().trim().min(2).max(200),
  /** The customer's number, without the `rcs:` an RCS message carries in front of it. */
  from: e164Phone,
  /** The business's number it came in on, or the RCS sender's address (`rcs:<id>`) for an RCS message. */
  to: z.union([
    e164Phone,
    z
      .string()
      .trim()
      .regex(/^rcs:[A-Za-z0-9][A-Za-z0-9_.-]{1,99}$/),
  ]),
  /** How it came in (0103): as an ordinary text, or over RCS. */
  via: z.enum(['sms', 'rcs']).default('sms'),
  /**
   * A button the customer tapped on RCS (0103): Twilio's `ButtonPayload` (the id we gave it), `ButtonText` and
   * `ButtonType`. The body is the button's name either way.
   */
  button: z
    .object({
      payload: z.string().trim().max(300).nullable(),
      text: z.string().trim().max(300).nullable(),
      type: z.string().trim().max(40).nullable(),
    })
    .optional(),
  body: z.string().max(10000).default(''),
  media: z.array(MediaRefSchema).max(10).default([]),
  /** Photos the provider still holds; the worker copies them and calls message.attach_media. */
  mediaCount: z.number().int().min(0).max(10).default(0),
  /**
   * The carrier already replied to this STOP, START or HELP (Twilio's Advanced Opt-Out, which says so with
   * `OptOutType`), so HandsFreeOS sends no answer of its own.
   */
  keywordAnswered: z.boolean().default(false),
  /** Tests and demos shorten the reply reminder; otherwise the workspace setting decides. */
  reminderAfterMs: z.number().int().min(1000).max(86_400_000).optional(),
  occurredAt: isoDateTime.optional(),
});
export const MessageReceiveOutput = z.object({
  messageId: uuid,
  conversationId: uuid,
  duplicate: z.boolean(),
  /** A carrier keyword, or 'confirm': a C (CONFIRM, CONFIRMED) that answered HandsFreeOS's ask to confirm. */
  keyword: z.enum(['stop', 'start', 'help', 'confirm']).nullable(),
  /** The bookings this reply confirmed (a C, or a YES while an ask was open). */
  confirmedAttendeeIds: z.array(uuid).default([]),
});
export const deliveryStatusUpdate = z.enum([
  'sending',
  'sent',
  'delivered',
  /** RCS: the customer opened it (0103). */
  'read',
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
    /** Texts: which way it actually went, when the carrier says (an RCS-first text learns it here). */
    transport: textTransport.optional(),
    /** A rich text's content template at the carrier, recorded with its provider id when it is sent (0103). */
    contentSid: z.string().trim().min(2).max(64).optional(),
    /**
     * A retry's send (message.retry): the provider id of the attempt that failed. The new provider id takes its
     * place, and that attempt's times, template and way it went are forgotten with it.
     */
    replacesProviderMessageId: z.string().trim().min(2).max(200).optional(),
    /**
     * Messenger and Instagram: every part the reply went out as (its photos, then its words), by Meta's ids. The
     * first is `providerMessageId`.
     */
    providerPartIds: z.array(z.string().trim().min(2).max(300)).max(20).optional(),
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
/** Worker: a text held until quiet hours end, when they do. */
export const MessageReleaseScheduledInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageReleaseScheduledOutput = z.object({
  messageId: uuid,
  /**
   * sent: it went to the worker's sender; waiting: not yet (quiet hours again, or early), try at `retryAt`;
   * cancelled: someone cancelled it; refused: a check a text passes said no (it failed, with the reason);
   * gone: nothing is waiting any more.
   */
  outcome: z.enum(['sent', 'waiting', 'cancelled', 'refused', 'gone']),
  retryAt: isoDateTime.nullable(),
});

// ---------- the thread: messages and calls, newest first ----------
/** What Messenger and Instagram add to a message (`messages.social`), as a thread shows it. */
export const SocialExtrasOut = z.object({
  shared: z
    .array(z.object({ type: z.string(), url: z.string().nullable(), title: z.string().nullable() }))
    .optional(),
  elsewhere: z.boolean().optional(),
  replyTo: z
    .object({ mid: z.string().nullable(), story: z.boolean(), storyUrl: z.string().nullable() })
    .optional(),
  postback: z.object({ title: z.string().nullable() }).optional(),
  files: z.array(z.string()).optional(),
  touchId: uuid.optional(),
});

export const ThreadItem = z.object({
  type: z.enum(['message', 'call']),
  id: uuid,
  occurredAt: isoDateTime,
  direction: messageDirection,
  status: z.string(),
  channel: conversationChannel.nullable(),
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
  /** 'bridge': a call through the teammate's own cell (answeredBy is who pressed 1 to place it). */
  answeredVia: z.enum(['browser', 'forwarding', 'bridge', 'ai']).nullable(),
  /** A text waiting for quiet hours to end: when it goes (it can still be cancelled). */
  scheduledFor: isoDateTime.nullable(),
  transcript: z.string().nullable(),
  /** Where the words got to: null before anything was asked, then pending, completed or failed. */
  transcriptStatus: z.enum(['pending', 'completed', 'failed']).nullable(),
  answeredBy: UserRef,
  /** Which lane it is on, so "All" can say which line each message was to or from (0089). */
  conversationId: uuid.nullable(),
  /** That lane's line, ready to show: "Front desk · (713) 555-0142", "support@acme.com". */
  lineDisplay: z.string().nullable(),
  /** Email: the sanitized HTML body (received mail), the recipients, and the mailbox it went through. */
  bodyHtml: z.string().nullable(),
  toAddresses: z.array(z.string()),
  ccAddresses: z.array(z.string()),
  via: z.enum(['microsoft', 'google']).nullable(),
  /** The AI teammate that sent it (M7). */
  teammate: z.object({ id: uuid, name: z.string() }).nullable(),
  /** The person whose OK sent the teammate's message (its draft's approver). */
  approvedBy: UserRef,
  /** The teammate's draft it came from. */
  aiDraftId: uuid.nullable(),
  /** The business's hand-off line ("someone from our team will reply"), sent when the teammate handed it over. */
  handoffLine: z.boolean(),
  /** Texts: how it went or came in — sms, mms or rcs — once the carrier has said (0103). */
  transport: textTransport.nullable(),
  /** Texts sent over RCS: when the customer opened it. */
  readAt: isoDateTime.nullable(),
  /** The buttons, card or carousel it carried, and the words a phone without RCS got instead. */
  rich: RichTextOut.nullable(),
  /** A customer's reply that came from one of those buttons. */
  buttonReply: ButtonReplyOut.nullable(),
  /**
   * Messenger and Instagram (20261025000200): what it shared that isn't a file we keep, what it answers, the button
   * tapped, and whether the business wrote it in Facebook's or Instagram's own inbox. Null on other channels.
   */
  social: SocialExtrasOut.nullable(),
  /** The customer changed it (Messenger, Instagram): the body is the newest words. */
  editedAt: isoDateTime.nullable(),
  /** The customer took it back: nothing of what it said is kept. */
  unsentAt: isoDateTime.nullable(),
});
export type ThreadItem = z.infer<typeof ThreadItem>;
export const ConversationThreadInput = ListInput.extend({
  workspaceId: uuid,
  conversationId: uuid,
  /** Only items after this moment (live refreshes fetch just what is new). */
  since: isoDateTime.optional(),
  /**
   * Every lane this customer has, woven into one timeline, newest first (0089).
   *
   * What the inbox's "All" shows: the whole history with somebody, texts on either of the business's numbers
   * and mail on either of its addresses together, each item saying which line it was on. Nothing can be sent
   * from it — a reply has to be on a line, and "all" is not one — so this only ever reads.
   */
  allLanes: z.boolean().optional(),
});
export const ConversationThreadOutput = z.object({
  items: z.array(ThreadItem),
  nextCursor: z.string().nullable(),
});
export const MessageGetInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageGetOutput = z.object({
  message: ThreadItem,
  conversationId: uuid,
  /**
   * A failed text tried again in quiet hours, waiting for them to end: cancelling it puts it back as it was, not
   * delivered, rather than taking it out of the conversation.
   */
  triedAgain: z.boolean(),
});

export const PersonSetSmsConsentInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  consent: z.enum(['opted_in', 'opted_out']),
});
export const PersonSetSmsConsentOutput = z.object({ personId: uuid, consent: smsConsent });

/** The customer's own message that asks to stop ("stop texting me"). */
export const MessageRecordOptOutInput = z.object({ workspaceId: uuid, messageId: uuid });
export const MessageRecordOptOutOutput = z.object({
  conversationId: uuid,
  /** The customer record marked opted out, when the conversation has one. */
  personId: uuid.nullable(),
  /** The number that can't be texted from now on; null when there's none to record. */
  number: z.string().nullable(),
  /** False when they had opted out already, or there was nothing to record. */
  changed: z.boolean(),
});

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
  /**
   * Out-of-office replies, lists and bulk mail (M19): a stranger's goes to Other mail, and it still never opens
   * or wakes up a customer's Inbox thread.
   */
  automatic: z.boolean().default(false),
  /** What the mail service's spam filter scored it (Postmark's X-Spam-Score); a stranger's at SPAM_SCORE is spam. */
  spamScore: z.number().min(-1000).max(1000).nullable().optional(),
  /** Tests and demos shorten the reply reminder. */
  reminderAfterMs: z.number().int().min(1000).max(86_400_000).optional(),
});
export const EmailReceiveOutput = z.object({
  /** unmatched is from before M19, when a stranger's mail waited under Mail from people not in Contacts. */
  outcome: z.enum(['filed', 'duplicate', 'unmatched', 'skipped']),
  messageId: uuid.nullable(),
  conversationId: uuid.nullable(),
  unmatchedId: uuid.nullable(),
  /** The folder of the thread it was filed in (M19). */
  folder: z.enum(['inbox', 'other', 'spam']).nullable().optional(),
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
      /** The person's own address (M19): email from it stays in their own mailbox. */
      mine: z.boolean().optional(),
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
