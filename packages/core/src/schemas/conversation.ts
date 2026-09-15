import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { AddressOut, ListInput, TagRef, UserRef } from './crm';
import { QuietState } from './telephony';

/** What a person can open a conversation on (conversation.open): a text or an email. */
export const messageChannel = z.enum(['sms', 'email']);
export type MessageChannel = z.infer<typeof messageChannel>;
/** What a conversation is on: a text, an email, or a website chat (M7). */
export const conversationChannel = z.enum(['sms', 'email', 'chat']);
export type ConversationChannel = z.infer<typeof conversationChannel>;
export const conversationStatus = z.enum(['open', 'snoozed', 'closed']);
/** needs_person: handed to a person and not yet picked up (oldest first); ai: the AI teammate answers. */
export const inboxBox = z.enum(['mine', 'unassigned', 'all', 'needs_person', 'ai']);
export const messageDirection = z.enum(['inbound', 'outbound']);
export const smsConsent = z.enum(['unknown', 'opted_in', 'opted_out']);

export const OpenLeadRef = z.object({
  id: uuid,
  title: z.string(),
  stageName: z.string(),
  valueCents: z.number(),
  nextAction: z.string().nullable(),
  nextActionAt: isoDateTime.nullable(),
});
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
  openLead: OpenLeadRef.nullable(),
  createdAt: isoDateTime,
});
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const InboxListInput = ListInput.extend({
  workspaceId: uuid,
  box: inboxBox.default('all'),
  status: conversationStatus.default('open'),
  channel: conversationChannel.optional(),
  q: z.string().trim().max(100).optional(),
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
  quiet: QuietState,
  timezone: z.string(),
});

const conversationRef = { workspaceId: uuid, conversationId: uuid };
export const ConversationOpenInput = z.object({
  workspaceId: uuid,
  personId: uuid,
  channel: messageChannel.default('sms'),
});
export const ConversationOpenOutput = z.object({ conversationId: uuid, created: z.boolean() });
export const ConversationRefInput = z.object(conversationRef);
export const ConversationRefOutput = z.object({ conversationId: uuid });
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
export const ConversationLinkPersonOutput = z.object({
  conversationId: uuid,
  personId: uuid,
  phoneAdded: z.boolean(),
});
