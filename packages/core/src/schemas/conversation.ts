import { z } from 'zod';
import { conversationHandoffReason } from './ai-team';
import { isoDateTime, uuid } from './common';
import { AddressOut, ListInput, notApplied, TagRef, UserRef } from './crm';
import { QuietState } from './telephony';

/** What a person can open a conversation on (conversation.open): a text or an email. */
export const messageChannel = z.enum(['sms', 'email']);
export type MessageChannel = z.infer<typeof messageChannel>;
/** What a conversation is on: a text, an email, or a website chat (M7). */
export const conversationChannel = z.enum(['sms', 'email', 'chat']);
export type ConversationChannel = z.infer<typeof conversationChannel>;
export const conversationStatus = z.enum(['open', 'snoozed', 'closed']);
/**
 * needs_person: handed to a person and not yet picked up (oldest first); ai: the AI teammate answers. other and
 * spam are the email folders beside the Inbox (M19); every other box is the Inbox's.
 */
export const inboxBox = z.enum([
  'mine',
  'unassigned',
  'all',
  'needs_person',
  'ai',
  'archived',
  'other',
  'spam',
]);
/** Where a thread lives (M19): only Inbox threads wake the AI teammate, workflows, push and the timeline. */
export const conversationFolder = z.enum(['inbox', 'other', 'spam']);
export type ConversationFolderValue = z.infer<typeof conversationFolder>;
export const messageDirection = z.enum(['inbound', 'outbound']);
export const smsConsent = z.enum(['unknown', 'opted_in', 'opted_out']);

export const OpenLeadRef = z.object({
  id: uuid,
  title: z.string(),
  /** Its stage and pipeline, so a conversation can move the lead along without loading the board. */
  stageId: uuid,
  pipelineId: uuid,
  stageName: z.string(),
  valueCents: z.number(),
  nextAction: z.string().nullable(),
  nextActionAt: isoDateTime.nullable(),
});
/**
 * One of a customer's lanes: a thread of theirs, named by the business's own end of it (0089).
 *
 * The inbox shows a customer once and switches between these, so the label is what tells somebody which of
 * the business's lines they are about to answer on — and `lineId` null is a lane with no line, which is a
 * website chat or a business with nothing to send from.
 */
export const ConversationLane = z.object({
  id: uuid,
  channel: conversationChannel,
  lineId: uuid.nullable(),
  /** "Front desk · (713) 555-0142", "support@acme.com", "Website chat". Ready to show. */
  lineDisplay: z.string(),
  unreadCount: z.number().int(),
  status: conversationStatus,
  archived: z.boolean(),
  lastMessageAt: isoDateTime.nullable(),
  assignee: UserRef,
});
export type ConversationLane = z.infer<typeof ConversationLane>;

export const ConversationSummary = z.object({
  id: uuid,
  channel: conversationChannel,
  counterpart: z.string(),
  counterpartDisplay: z.string(),
  status: conversationStatus,
  person: z.object({ id: uuid, fullName: z.string() }).nullable(),
  assignee: UserRef,
  unreadCount: z.number().int(),
  lastMessageAt: isoDateTime.nullable(),
  lastPreview: z.string().nullable(),
  lastDirection: messageDirection.nullable(),
  /** Who sent the last message when the business sent it ("You: …", "Marco: …" in the list). */
  lastSentBy: UserRef,
  awaitingReplySince: isoDateTime.nullable(),
  snoozedUntil: isoDateTime.nullable(),
  /** Put away, so it is out of the inbox until somebody brings it back. Its status is untouched. */
  archived: z.boolean(),
  openLead: OpenLeadRef.nullable(),
  createdAt: isoDateTime,
  /** Who answers it (M7): nobody in particular, the AI teammate, or a person who took it or picked it up. */
  handledBy: z.enum(['none', 'ai', 'person']),
  /** The AI teammate that answers it, or answered it before a person took over ("Hand back to Ava"). */
  teammate: z.object({ id: uuid, name: z.string() }).nullable(),
  /** Handed to a person and nobody has picked it up yet ("Needs a person"). */
  needsPersonSince: isoDateTime.nullable(),
  /** Why it went to a person. */
  handoffReason: conversationHandoffReason.nullable(),
  /** The teammate's note for whoever picks it up. */
  handoffNote: z.string().nullable(),
  /** Who took it over from the teammate. */
  takenOverBy: UserRef,
  /** A website chat whose visitor's chat window checked in within the last 2 minutes ("On the site now"). */
  onSiteNow: z.boolean(),
  /**
   * Every lane of this customer the viewer may see, the one that spoke most recently first (0089).
   *
   * The row itself is the first of them, so a client that ignores this field shows exactly what it showed
   * before. "The viewer may see" is not a filter this query applies — RLS does it, which is how a narrowed
   * inbox (0083) keeps a member from learning that a thread they are not on exists.
   */
  lanes: z.array(ConversationLane),
  /** Unread across every lane above, which is what the customer's row badges. */
  unreadTotal: z.number().int(),
  /** A customer this unlinked thread looks like, offered as "Same as …?" rather than merged on its own. */
  sameAs: z.object({ id: uuid, fullName: z.string() }).nullable(),
  /** Where it lives (M19): the Inbox, Other mail or Spam. */
  folder: conversationFolder,
  /** The viewer's own mail (M19): only they see it, until they share it with the team. */
  private: z.boolean(),
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const InboxListInput = ListInput.extend({
  workspaceId: uuid,
  box: inboxBox.default('all'),
  /** The team's threads, or the person's own mailbox (M19): the same boxes, over their own mail. */
  mailbox: z.enum(['team', 'mine']).default('team'),
  status: conversationStatus.default('open'),
  channel: conversationChannel.optional(),
  q: z.string().trim().max(100).optional(),
  /** Only threads with something unread, within the box and status (the "Unread" filter). */
  unread: z.boolean().optional(),
  /** One customer's conversations in any status (the record page); `status` is ignored with it. */
  personId: uuid.optional(),
});
export const InboxListOutput = z.object({
  items: z.array(ConversationSummary),
  nextCursor: z.string().nullable(),
});

const BoxCounts = z.object({
  mine: z.number().int(),
  unassigned: z.number().int(),
  all: z.number().int(),
});
export const InboxSummaryInput = z.object({ workspaceId: uuid });
export const InboxSummaryOutput = z.object({
  /** Open conversations with something unread, per box (the sidebar badge uses `all`). */
  unread: BoxCounts,
  open: BoxCounts,
  /** Open conversations whose customer has waited past the reminder threshold. */
  waiting: z.number().int(),
  waitingThresholdMinutes: z.number().int(),
  /** Open conversations handed to a person that nobody has picked up yet. */
  needsPerson: z.number().int(),
  /** Open conversations the AI teammate is answering. */
  ai: z.number().int(),
  /**
   * Beside the team's Inbox (M19): unread in the viewer's own mailbox, unread in the team's Other mail, and open
   * threads in the team's Spam.
   */
  mail: z.object({ mine: z.number().int(), other: z.number().int(), spam: z.number().int() }),
});

export const canTextReason = z.enum([
  'no_number',
  'not_ready',
  'opted_out',
  'no_phone',
  'email_channel',
  'chat_channel',
]);
/**
 * A website chat's visitor, for the inbox: what they typed ("Said their name is …", never verified), the
 * page they're on, "On the site now", and whether they're blocked. Never a token hash or the hashed IP.
 */
export const ConversationChat = z.object({
  visitorId: uuid,
  widgetId: uuid,
  /** The site the widget is on ("lonestarhvac.com"). */
  site: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  phoneE164: z.string().nullable(),
  email: z.string().nullable(),
  /** How the linked customer matched what they typed. */
  matchedOn: z.enum(['phone', 'email']).nullable(),
  /** The page their chat window last checked in from. */
  pagePath: z.string().nullable(),
  lastSeenAt: isoDateTime.nullable(),
  /** Their chat window checked in within the last 2 minutes. */
  onSiteNow: z.boolean(),
  blocked: z.boolean(),
  networkBlockedUntil: isoDateTime.nullable(),
});
export type ConversationChat = z.infer<typeof ConversationChat>;
export const ConversationGetInput = z.object({ workspaceId: uuid, conversationId: uuid });
export const ConversationGetOutput = z.object({
  conversation: ConversationSummary,
  /** Website chats only. */
  chat: ConversationChat.nullable(),
  person: z
    .object({
      id: uuid,
      fullName: z.string(),
      /**
       * The two halves behind `fullName`. Editing the name in the conversation sends what it saw as the merge
       * base, and splitting `fullName` back would guess wrong on "Mary Jane Smith". The row is already loaded,
       * so carrying both costs nothing.
       */
      firstName: z.string(),
      lastName: z.string(),
      phone: z.string().nullable(),
      phoneE164: z.string().nullable(),
      email: z.string().nullable(),
      address: AddressOut,
      tags: z.array(TagRef),
      customerSince: isoDateTime,
      smsConsent,
      archived: z.boolean(),
    })
    .nullable(),
  openTasks: z.array(
    z.object({
      id: uuid,
      title: z.string(),
      dueAt: isoDateTime.nullable(),
      allDay: z.boolean(),
      overdue: z.boolean(),
    }),
  ),
  canText: z.object({ ok: z.boolean(), reason: canTextReason.nullable() }),
  fromNumber: z.string().nullable(),
  /**
   * Texts here go RCS first (0103): the business's RCS sender is connected, approved and switched on. A phone
   * that can't show RCS still gets every message, as an ordinary text from `fromNumber`.
   */
  rcs: z.boolean(),
  quiet: QuietState,
  timezone: z.string(),
});

const conversationRef = { workspaceId: uuid, conversationId: uuid };
export const ConversationOpenInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  channel: messageChannel.default('sms'),
  /**
   * Another of the customer's numbers (for a text) or emails (for an email) to use instead of the main one (0103).
   * It has to be one they have on file.
   */
  to: z.string().trim().min(1).max(254).optional(),
});
export const ConversationOpenOutput = z.object({ conversationId: uuid, created: z.boolean() });
export const ConversationRefInput = z.object(conversationRef);
export const ConversationRefOutput = z.object({
  conversationId: uuid,
  /**
   * ['status'] when a close or snooze was overtaken (M10): the customer wrote, or someone reopened, closed or snoozed
   * it, later than it was made.
   */
  notApplied,
});
/** conversation.close_all: how many of the customer's lanes were still open when it ran (0089). */
export const ConversationCloseAllOutput = z.object({
  conversationId: uuid,
  closed: z.number().int(),
});

/** conversation.pick_up: the teammate that answers it now, and the conversation's new ai_epoch. */
export const ConversationPickUpOutput = z.object({
  conversationId: uuid,
  teammateId: uuid,
  aiEpoch: z.int(),
});
export const ConversationAssignInput = z.object({
  ...conversationRef,
  assigneeUserId: uuid.nullable(),
});
export const ConversationSnoozeInput = z.object({ ...conversationRef, until: isoDateTime });
export const ConversationLinkPersonInput = z.object({ ...conversationRef, personId: uuid });
/** Moving an email thread between the Inbox, Other mail and Spam (M19). */
export const ConversationMoveInput = z.object({
  ...conversationRef,
  folder: conversationFolder,
  /** Send the sender's next new thread to the same folder. */
  remember: z.boolean().default(false),
});
export const ConversationMoveOutput = z.object({
  conversationId: uuid,
  folder: conversationFolder,
  /** False when it was already there, so a double-click is visibly a no-op. */
  changed: z.boolean(),
});
/** Sharing a thread from a person's own mailbox with the team (M19). */
export const ConversationShareOutput = z.object({
  conversationId: uuid,
  /** The customer it is now linked to, when their address is on one. */
  personId: uuid.nullable(),
});
export const EmailSenderRuleRemoveInput = z.object({
  workspaceId: uuid,
  address: z.string().trim().toLowerCase().min(3).max(320),
});
export const EmailSenderRuleRemoveOutput = z.object({ address: z.string(), removed: z.boolean() });
export const ConversationLinkPersonOutput = z.object({
  conversationId: uuid,
  personId: uuid,
  phoneAdded: z.boolean(),
});

/** The call log: every call, or only the ones nobody took, or only the ones that left a voicemail. */
export const callLogFilter = z.enum(['all', 'missed', 'voicemail']);
export const CallLogInput = ListInput.extend({
  workspaceId: uuid,
  filter: callLogFilter.default('all'),
});
export const CallLogItem = z.object({
  id: uuid,
  conversationId: uuid.nullable(),
  personId: uuid.nullable(),
  /** The customer's name once somebody has linked the number, else the number itself. */
  who: z.string(),
  counterpart: z.string(),
  direction: messageDirection,
  status: z.string(),
  occurredAt: isoDateTime,
  durationSeconds: z.number().int().nullable(),
  isVoicemail: z.boolean(),
  answeredVia: z.enum(['browser', 'forwarding', 'bridge', 'ai']).nullable(),
  answeredBy: UserRef,
  /** The stored recording (telephony bucket), for the player. Null when none reached us. */
  recordingPath: z.string().nullable(),
  recordingSeconds: z.number().int().nullable(),
  transcript: z.string().nullable(),
  transcriptStatus: z.enum(['pending', 'completed', 'failed']).nullable(),
});
export const CallLogOutput = z.object({
  items: z.array(CallLogItem),
  nextCursor: z.string().nullable(),
});
