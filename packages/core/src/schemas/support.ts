/**
 * Milestone 13 schemas: the support desk (tickets, replies, drafts, saved replies), the staff who run it,
 * and the admin side (businesses, health, looking at a business read-only). Browser-safe.
 */
import { z } from 'zod';
import { displayName, email, isoDateTime, uuid } from './common';

export const TicketStatusValue = z.enum(['new', 'open', 'waiting_on_customer', 'solved', 'closed']);
export type TicketStatusValue = z.infer<typeof TicketStatusValue>;
export const TicketPriorityValue = z.enum(['low', 'normal', 'high', 'urgent']);
export const TicketChannelValue = z.enum(['email', 'in_app', 'chat']);
export const StaffRoleValue = z.enum(['agent', 'lead', 'admin']);
export const StaffStatusValue = z.enum(['active', 'suspended']);

const body = z.string().trim().min(1, 'Write something first.').max(20000);
const subject = z.string().trim().max(200);
const limit = z.int().min(1).max(100).default(25);
const cursor = z.string().max(400).optional();

const Person = z.object({
  userId: uuid.nullable(),
  name: z.string(),
  email: z.string(),
});
const Business = z.object({
  workspaceId: uuid,
  name: z.string(),
  organizationId: uuid.nullable(),
});

export const TicketSummary = z.object({
  id: uuid,
  number: z.int(),
  subject: z.string(),
  status: TicketStatusValue,
  priority: TicketPriorityValue,
  channel: TicketChannelValue,
  requester: Person,
  business: Business.nullable(),
  assignee: Person.nullable(),
  tags: z.array(z.string()),
  /** The last thing either side said, so a queue can be read at a glance. */
  preview: z.string(),
  waitingSince: isoDateTime.nullable(),
  snoozeUntil: isoDateTime.nullable(),
  firstResponseAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type TicketSummary = z.infer<typeof TicketSummary>;

export const TicketMessage = z.object({
  id: uuid,
  author: z.enum(['customer', 'staff', 'ai', 'system']),
  internal: z.boolean(),
  authorName: z.string(),
  bodyText: z.string(),
  bodyHtml: z.string().nullable(),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), sizeBytes: z.int() })),
  createdAt: isoDateTime,
});

export const TicketEvent = z.object({
  id: uuid,
  kind: z.string(),
  actorName: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
});

export const TicketDraft = z.object({
  bodyText: z.string(),
  sources: z.array(z.object({ kind: z.string(), title: z.string(), id: z.string().nullable() })),
  model: z.string(),
  createdAt: isoDateTime,
  /** True once the conversation has moved on: shown greyed out rather than hidden. */
  stale: z.boolean(),
});

// ---------- looking at the queue ----------

export const TicketListInput = z.object({
  status: z.array(TicketStatusValue).max(5).optional(),
  /** 'mine' and 'unassigned' are what a queue is read by; a user id is for looking at someone else's. */
  assignee: z.union([z.enum(['mine', 'unassigned', 'anyone']), uuid]).default('anyone'),
  search: z.string().trim().max(200).optional(),
  workspaceId: uuid.optional(),
  /** Snoozed tickets are out of the queue until their time comes; this puts them back in view. */
  includeSnoozed: z.boolean().default(false),
  limit,
  cursor,
});
export const TicketListOutput = z.object({
  tickets: z.array(TicketSummary),
  nextCursor: z.string().nullable(),
});

export const TicketGetInput = z.object({ ticketId: uuid });
export const TicketGetOutput = z.object({
  ticket: TicketSummary,
  messages: z.array(TicketMessage),
  events: z.array(TicketEvent),
  draft: TicketDraft.nullable(),
  /** What we know about the business they are asking about, so nobody has to go and look it up. */
  business: z
    .object({
      workspaceId: uuid,
      name: z.string(),
      organizationName: z.string(),
      createdAt: isoDateTime,
      memberCount: z.int(),
      openTicketCount: z.int(),
    })
    .nullable(),
  /** Their other tickets, newest first. */
  alsoFrom: z.array(
    z.object({ id: uuid, number: z.int(), subject: z.string(), status: TicketStatusValue }),
  ),
});
export type TicketGetOutput = z.infer<typeof TicketGetOutput>;

export const QueueSummaryInput = z.object({});
export const QueueSummaryOutput = z.object({
  unanswered: z.int(),
  mine: z.int(),
  unassigned: z.int(),
  waitingOnCustomer: z.int(),
  solvedToday: z.int(),
  /** How long the oldest unanswered ticket has been waiting, in minutes. */
  oldestWaitingMinutes: z.int().nullable(),
});

// ---------- answering ----------

export const TicketReplyInput = z.object({
  ticketId: uuid,
  body,
  /** An internal note: staff read it, the customer never does. */
  internal: z.boolean().default(false),
  /** What the ticket becomes once this is sent. Left out, a reply waits on the customer. */
  status: TicketStatusValue.optional(),
});
export const TicketReplyOutput = z.object({
  messageId: uuid,
  status: TicketStatusValue,
});

export const TicketRefInput = z.object({ ticketId: uuid });
export const TicketWriteOutput = z.object({ ticketId: uuid });

export const TicketSetStatusInput = z.object({ ticketId: uuid, status: TicketStatusValue });
export const TicketAssignInput = z.object({ ticketId: uuid, assigneeUserId: uuid.nullable() });
export const TicketSnoozeInput = z.object({ ticketId: uuid, until: isoDateTime.nullable() });
export const TicketSetPriorityInput = z.object({ ticketId: uuid, priority: TicketPriorityValue });
export const TicketLinkBusinessInput = z.object({ ticketId: uuid, workspaceId: uuid.nullable() });
export const TicketMergeInput = z.object({ ticketId: uuid, intoTicketId: uuid });

// ---------- asking for help from inside HandsFreeOS ----------

export const SupportRequestInput = z.object({
  workspaceId: uuid,
  subject,
  body,
  /** What the screen already knows: the page, the app build, the last error. Never anything typed. */
  context: z
    .object({
      page: z.string().max(200).optional(),
      appVersion: z.string().max(40).optional(),
      platform: z.enum(['web', 'ios', 'android']).optional(),
      lastError: z.string().max(2000).optional(),
    })
    .default({}),
});
export const SupportRequestOutput = z.object({ ticketId: uuid, number: z.int() });

// ---------- saved replies ----------

export const CannedReply = z.object({
  id: uuid,
  title: z.string(),
  bodyText: z.string(),
  updatedAt: isoDateTime,
});
export const CannedReplyListInput = z.object({});
export const CannedReplyListOutput = z.object({ replies: z.array(CannedReply) });
export const CannedReplySaveInput = z.object({
  id: uuid.optional(),
  title: z.string().trim().min(1).max(200),
  bodyText: z.string().trim().min(1).max(20000),
});
export const CannedReplySaveOutput = z.object({ id: uuid });
export const CannedReplyDeleteInput = z.object({ id: uuid });
export const CannedReplyDeleteOutput = z.object({ id: uuid });

// ---------- the people who answer ----------

export const StaffMember = z.object({
  userId: uuid,
  fullName: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: StaffRoleValue,
  status: StaffStatusValue,
  openTicketCount: z.int(),
  createdAt: isoDateTime,
});
export const StaffInvitation = z.object({
  id: uuid,
  email: z.string(),
  role: StaffRoleValue,
  invitedByName: z.string(),
  sentAt: isoDateTime.nullable(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
});
export const StaffListInput = z.object({});
export const StaffListOutput = z.object({
  staff: z.array(StaffMember),
  invitations: z.array(StaffInvitation),
});

export const StaffInviteInput = z.object({ email, role: StaffRoleValue.default('agent') });
export const StaffInviteOutput = z.object({ invitationId: uuid });
export const StaffInvitationRefInput = z.object({ invitationId: uuid });
export const StaffInvitationWriteOutput = z.object({ invitationId: uuid });
export const StaffAcceptInput = z.object({ token: z.string().trim().min(10).max(200) });
export const StaffAcceptOutput = z.object({
  accepted: z.boolean(),
  role: StaffRoleValue.nullable(),
  /** Why not, when it did not work: unknown, already_accepted, revoked, expired, wrong_address. */
  reason: z.string().nullable(),
});
export const StaffSetRoleInput = z.object({
  userId: uuid,
  role: StaffRoleValue.optional(),
  status: StaffStatusValue.optional(),
});
export const StaffWriteOutput = z.object({ userId: uuid });
export const StaffRemoveInput = z.object({ userId: uuid });
export const StaffProfileInput = z.object({
  displayName: displayName.max(120),
  signature: z.string().trim().max(2000).default(''),
});

// ---------- who am I ----------

export const PlatformMeInput = z.object({});
export const PlatformMeOutput = z.object({
  staff: z
    .object({
      userId: uuid,
      role: StaffRoleValue,
      displayName: z.string(),
      signature: z.string(),
      permissions: z.array(z.string()),
    })
    .nullable(),
});

// ---------- the businesses ----------

export const BusinessRow = z.object({
  workspaceId: uuid,
  name: z.string(),
  organizationId: uuid,
  organizationName: z.string(),
  industry: z.string(),
  timezone: z.string(),
  memberCount: z.int(),
  /** The last time anybody in the business did anything at all. */
  lastActiveAt: isoDateTime.nullable(),
  openTicketCount: z.int(),
  createdAt: isoDateTime,
});
export const BusinessListInput = z.object({
  search: z.string().trim().max(200).optional(),
  sort: z.enum(['newest', 'busiest', 'quietest', 'name']).default('newest'),
  limit,
  cursor,
});
export const BusinessListOutput = z.object({
  businesses: z.array(BusinessRow),
  nextCursor: z.string().nullable(),
  totals: z.object({
    businesses: z.int(),
    newThisWeek: z.int(),
    activeThisWeek: z.int(),
  }),
});

export const BusinessGetInput = z.object({ workspaceId: uuid });
export const BusinessGetOutput = z.object({
  business: BusinessRow,
  people: z.array(
    z.object({
      userId: uuid,
      fullName: z.string(),
      email: z.string(),
      role: z.string(),
      lastActiveAt: isoDateTime.nullable(),
    }),
  ),
  counts: z.object({
    people: z.int(),
    leads: z.int(),
    conversations: z.int(),
    appointments: z.int(),
    invoices: z.int(),
  }),
  tickets: z.array(
    z.object({
      id: uuid,
      number: z.int(),
      subject: z.string(),
      status: TicketStatusValue,
      createdAt: isoDateTime,
    }),
  ),
  /** What is set up, as a support person would ask it: can they text, email, take money, book. */
  setup: z.object({
    phone: z.boolean(),
    email: z.boolean(),
    payments: z.boolean(),
    calendar: z.boolean(),
    aiTeammate: z.boolean(),
  }),
});

// ---------- is anything broken ----------

export const HealthSummaryInput = z.object({
  /** How far back to look. A support person asks about today; a Monday morning asks about the weekend. */
  hours: z.int().min(1).max(168).default(24),
});
const HealthCount = z.object({
  label: z.string(),
  count: z.int(),
  /** The business it happened in most, when one stands out. */
  worstBusiness: z.string().nullable(),
});
export const HealthSummaryOutput = z.object({
  since: isoDateTime,
  failedJobs: HealthCount,
  failedDeliveries: HealthCount,
  emailBounces: HealthCount,
  failedTexts: HealthCount,
  paymentFailures: HealthCount,
  /** Work waiting longer than it should be. */
  outboxBacklog: z.int(),
  oldestPendingMinutes: z.int().nullable(),
  recent: z.array(
    z.object({
      kind: z.string(),
      at: isoDateTime,
      business: z.string().nullable(),
      detail: z.string(),
    }),
  ),
});

// ---------- looking at a business ----------

export const ViewAsStartInput = z.object({
  workspaceId: uuid,
  reason: z.string().trim().min(3, 'Say why, in a few words.').max(500),
  ticketId: uuid.optional(),
  /** How long it stays open. It ends by itself either way. */
  minutes: z.int().min(5).max(240).default(60),
});
export const ViewAsSession = z.object({
  id: uuid,
  workspaceId: uuid,
  businessName: z.string(),
  reason: z.string(),
  startedAt: isoDateTime,
  expiresAt: isoDateTime,
});
export const ViewAsStartOutput = z.object({ session: ViewAsSession });
export const ViewAsEndInput = z.object({ sessionId: uuid.optional() });
export const ViewAsEndOutput = z.object({ ended: z.boolean() });
export const ViewAsCurrentInput = z.object({});
export const ViewAsCurrentOutput = z.object({ session: ViewAsSession.nullable() });
