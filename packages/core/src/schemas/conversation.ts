import { z } from 'zod';
import { isoDateTime, uuid } from './common';
import { AddressOut, ListInput, TagRef, UserRef } from './crm';
import { QuietState } from './telephony';

export const messageChannel = z.enum(['sms', 'email']);
export type MessageChannel = z.infer<typeof messageChannel>;
export const conversationStatus = z.enum(['open', 'snoozed', 'closed']);
export const inboxBox = z.enum(['mine', 'unassigned', 'all']);
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
  channel: messageChannel,
  counterpart: z.string(),
  counterpartDisplay: z.string(),
  status: conversationStatus,
  person: z.object({ id: uuid, fullName: z.string() }).nullable(),
  assignee: UserRef,
  unreadCount: z.number().int(),
  lastMessageAt: isoDateTime.nullable(),
  lastPreview: z.string().nullable(),
  lastDirection: messageDirection.nullable(),
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
  channel: messageChannel.optional(),
  q: z.string().trim().max(100).optional(),
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
});

export const canTextReason = z.enum([
  'no_number',
  'not_ready',
  'opted_out',
  'no_phone',
  'email_channel',
]);
export const ConversationGetInput = z.object({ workspaceId: uuid, conversationId: uuid });
export const ConversationGetOutput = z.object({
  conversation: ConversationSummary,
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
