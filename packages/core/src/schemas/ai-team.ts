/**
 * The AI teammate's commands and queries (M7): setting it up, its drafts, qualifying answers, handing
 * conversations between it and people, and booking for the customer it's talking to. The settings document
 * itself is ai-team/config.ts.
 */
import { z } from 'zod';
import { DISCLOSURE_MODES } from '../ai-team/config';
import { TEAMMATE_PRESET_KEYS } from '../ai-team/presets';
import { TEAMMATE_ISSUE_CODES } from '../ai-team/rules';
import type { HandOffReason } from '../ai-team/tools';
import { WeeklyHours } from '../calendar/config';
import {
  AppointmentBookOnlineOutput,
  AttendeeCancelOnlineOutput,
  AttendeeRescheduleOnlineOutput,
  GeoPointInput,
} from './calendar';
import { isoDateTime, uuid, workspaceRole } from './common';
import { ListInput, notApplied, UserRef } from './crm';

export const teammateStatus = z.enum(['off', 'training', 'automatic']);
export type TeammateStatus = z.infer<typeof teammateStatus>;

// ---------- hand-offs ----------

/** Why a conversation went to a person (conversations.handoff_reason; the database checks the same list). */
export const CONVERSATION_HANDOFF_REASONS = [
  'asked_for_person',
  'frustrated',
  'cant_answer',
  'sensitive',
  'emergency',
  'legal',
  'complaint',
  'refund',
  'cancellation',
  'limit',
  'budget',
  'wallet',
  'error',
  'draft_expired',
  'loop',
  'other',
] as const;
export const conversationHandoffReason = z.enum(CONVERSATION_HANDOFF_REASONS);
export type ConversationHandoffReason = z.infer<typeof conversationHandoffReason>;

const TOOL_HANDOFF_REASONS: Readonly<Record<HandOffReason, ConversationHandoffReason>> = {
  asked_for_person: 'asked_for_person',
  frustrated: 'frustrated',
  sensitive_topic: 'sensitive',
  emergency: 'emergency',
  unsure: 'cant_answer',
  other: 'other',
  reply_limit: 'limit',
  budget: 'budget',
  wallet: 'wallet',
  error: 'error',
  check_failed: 'error',
  draft_expired: 'draft_expired',
};

/** The conversation's hand-off reason for the teammate's `hand_off` tool reason (or one the worker picks). */
export function conversationHandoffReasonOf(reason: HandOffReason): ConversationHandoffReason {
  return TOOL_HANDOFF_REASONS[reason];
}

// ---------- drafts (ai_teammate_drafts.preview and .edits) ----------

/** The message a draft sends once approved. */
export const DraftMessage = z.object({
  channel: z.enum(['sms', 'email', 'chat']),
  body: z.string().trim().min(1).max(10000),
  subject: z.string().trim().max(200).nullable().default(null),
  /** The customer's message it answers (the quiet-hours reply window needs the latest one). */
  inReplyToMessageId: uuid.nullable().default(null),
});
export type DraftMessage = z.infer<typeof DraftMessage>;

/** One line of a bill or a quote the teammate puts together: a product on the price list and how many. */
export const CatalogueLine = z.object({
  productId: uuid,
  quantity: z.number().gt(0).max(10_000),
});
export type CatalogueLine = z.infer<typeof CatalogueLine>;

/** The held changes that ask for money: only ever in an approval draft (M18). */
export const MONEY_DRAFT_ACTIONS = [
  'share_link',
  'create_invoice',
  'create_estimate',
  'estimate_answer',
  'start_plan',
] as const;

/** How often repeat visits come round: every week, or every month on the same weekday ("2nd Tuesday"). */
export const REPEAT_EVERY = ['week', 'month'] as const;
export const repeatEvery = z.enum(REPEAT_EVERY);

/** A customer-facing change held in a draft until a person approves it. `summary` is what the card shows. */
export const DraftAction = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('book'),
    calendarId: uuid,
    startsAt: isoDateTime,
    serviceId: uuid.nullable().default(null),
    durationMinutes: z.int().min(5).max(720).nullable().default(null),
    sessionId: uuid.nullable().default(null),
    notes: z.string().trim().max(1000).nullable().default(null),
    /** The ZIP the times were found for, on a calendar that routes by ZIP (M18). */
    postalCode: z.string().trim().max(20).nullable().default(null),
    /** M18: where their address is, for distance and drawn service areas. */
    point: GeoPointInput.nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
  /** M18: repeat visits, the first at a time find_times offered. */
  z.object({
    kind: z.literal('book_series'),
    calendarId: uuid,
    startsAt: isoDateTime,
    serviceId: uuid.nullable().default(null),
    durationMinutes: z.int().min(5).max(720).nullable().default(null),
    every: repeatEvery,
    interval: z.int().min(1).max(12).default(1),
    times: z.int().min(2).max(52),
    notes: z.string().trim().max(1000).nullable().default(null),
    postalCode: z.string().trim().max(20).nullable().default(null),
    /** M18: where their address is, for distance and drawn service areas. */
    point: GeoPointInput.nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
  /**
   * M18, money: these only ever sit in an **approval** draft, which an owner or admin decides in every mode. A bill
   * or a quote is priced from the catalogue when it goes out, never by the model.
   */
  /**
   * The link to pay a bill or answer a quote already sent: the draft's message carries it, so approving sends
   * that and changes nothing else. It is here so the card says what the message is for.
   */
  z.object({
    kind: z.literal('share_link'),
    document: z.enum(['invoice', 'estimate']),
    documentId: uuid,
    summary: z.string().trim().max(300).default(''),
  }),
  z.object({
    kind: z.literal('create_invoice'),
    title: z.string().trim().max(200).nullable().default(null),
    lines: z.array(CatalogueLine).min(1).max(20),
    summary: z.string().trim().max(300).default(''),
  }),
  z.object({
    kind: z.literal('create_estimate'),
    title: z.string().trim().max(200).nullable().default(null),
    lines: z.array(CatalogueLine).min(1).max(20),
    summary: z.string().trim().max(300).default(''),
  }),
  z.object({
    kind: z.literal('estimate_answer'),
    estimateId: uuid,
    accepted: z.boolean(),
    name: z.string().trim().min(1).max(120),
    reason: z.string().trim().max(1000).nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
  z.object({
    kind: z.literal('start_plan'),
    planId: uuid,
    summary: z.string().trim().max(300).default(''),
  }),
  /** M18: a place on a calendar's waitlist, for a full session or a window of time. */
  z.object({
    kind: z.literal('waitlist'),
    calendarId: uuid,
    appointmentId: uuid.nullable().default(null),
    wantedFrom: isoDateTime.nullable().default(null),
    wantedTo: isoDateTime.nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
  z.object({
    kind: z.literal('reschedule'),
    appointmentId: uuid,
    startsAt: isoDateTime,
    sessionId: uuid.nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
  z.object({
    kind: z.literal('cancel'),
    appointmentId: uuid,
    reason: z.string().trim().max(300).nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
  /** M18: more on one of their visits: another service, more people coming, or a note for the team. */
  z.object({
    kind: z.literal('add_to_visit'),
    appointmentId: uuid,
    serviceId: uuid.nullable().default(null),
    guests: z.int().min(1).max(10).nullable().default(null),
    note: z.string().trim().max(1000).nullable().default(null),
    summary: z.string().trim().max(300).default(''),
  }),
]);
export type DraftAction = z.infer<typeof DraftAction>;

/**
 * What approving a draft does, as the person saw it: its held-back actions in order, then its message. An
 * approval draft (a discount) also says what it proposes.
 */
export const TeammateDraftPreview = z.object({
  message: DraftMessage.nullable().default(null),
  actions: z
    .array(DraftAction)
    .max(10)
    .default(() => []),
  discount: z
    .object({ percent: z.int().min(1).max(50), reason: z.string().trim().max(300) })
    .nullable()
    .default(null),
});
export type TeammateDraftPreview = z.infer<typeof TeammateDraftPreview>;

/** The approver's changes to the message; an approval with any counts as edited. */
export const TeammateDraftEdits = z.strictObject({
  body: z.string().trim().min(1, 'Write the message.').max(10000).optional(),
  subject: z.string().trim().max(200).optional(),
});
export type TeammateDraftEdits = z.infer<typeof TeammateDraftEdits>;

// ---------- qualifying answers (leads.qualification) ----------

export const qualificationStatus = z.enum(['qualified', 'not_a_fit', 'incomplete']);
export const LeadQualification = z.object({
  /** Question id → the answer in the customer's words, with the question's text as it was asked. */
  answers: z
    .record(
      z.string(),
      z.object({
        question: z.string(),
        answer: z.string(),
        answeredAt: isoDateTime,
        by: z.enum(['ai', 'person']),
      }),
    )
    .default(() => ({})),
  status: qualificationStatus.default('incomplete'),
  missing: z.array(z.string()).default(() => []),
  notAFit: z.array(z.string()).default(() => []),
  /** When it first qualified (`lead.qualified`). */
  qualifiedAt: isoDateTime.nullable().default(null),
  updatedAt: isoDateTime.nullable().default(null),
});
export type LeadQualification = z.infer<typeof LeadQualification>;

// ---------- the teammate ----------

export const AiTeammateCreateInput = z.object({
  workspaceId: uuid,
  preset: z.enum(TEAMMATE_PRESET_KEYS),
  name: z.string().trim().min(1, 'Name your teammate.').max(40, 'Keep it under 40 characters.'),
  disclosure: z.enum(DISCLOSURE_MODES).default('first_message'),
});
export const AiTeammateCreateOutput = z.object({ teammateId: uuid, revision: z.int() });

export const AiTeammateSaveConfigInput = z.object({
  workspaceId: uuid,
  teammateId: uuid,
  /** The revision the draft started from; a save over someone else's is a revision_conflict. */
  baseRevision: z.int().min(1),
  /** A TeammateConfig; checked with parseTeammateConfig. */
  config: z.record(z.string(), z.unknown()),
});
export const AiTeammateSaveOutput = z.object({
  teammateId: uuid,
  revision: z.int(),
  labels: z.array(z.string()),
  /** What changed, one line each ("Name: Ava → Max"); empty when nothing did. */
  changes: z.array(z.string()),
});
export const AiTeammateRestoreInput = z.object({
  workspaceId: uuid,
  teammateId: uuid,
  /** The revision to bring back. */
  revision: z.int().min(1),
  baseRevision: z.int().min(1),
});

export const TeammateProgress = z.object({
  status: teammateStatus,
  approvedCount: z.int(),
  editedCount: z.int(),
  rejectedCount: z.int(),
  approvalsNeeded: z.int(),
  /** Approvals still needed before it turns automatic (0 once it has them). */
  remaining: z.int(),
  automaticVia: z.enum(['threshold', 'override']).nullable(),
});
export type TeammateProgress = z.infer<typeof TeammateProgress>;

export const AiTeammateSetStatusInput = z.object({
  workspaceId: uuid,
  teammateId: uuid,
  /** training → automatic is "Switch to automatic now"; automatic → training is "Back to training". */
  status: teammateStatus,
});
export const AiTeammateSetStatusOutput = z.object({ teammateId: uuid, progress: TeammateProgress });

export const AiTeammateDecideDraftInput = z
  .object({
    workspaceId: uuid,
    draftId: uuid,
    decision: z.enum(['approve', 'reject']),
    edits: TeammateDraftEdits.optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.decision === 'approve' || !v.edits, {
    path: ['edits'],
    error: 'Only an approval carries edits.',
  });
export const AiTeammateDecideDraftOutput = z.object({
  draftId: uuid,
  status: z.enum(['approved', 'rejected']),
  progress: TeammateProgress.extend({ becameAutomatic: z.boolean() }),
});

/** "Try again": a new draft of a reply someone rejected, answering the same messages with their reason in mind. */
export const AiTeammateRetryInput = z.object({ workspaceId: uuid, draftId: uuid });
export const AiTeammateRetryOutput = z.object({ draftId: uuid, conversationId: uuid });

export const AiTeammateSendDraftInput = z.object({ workspaceId: uuid, draftId: uuid });
export const AiTeammateSendDraftOutput = z.object({
  draftId: uuid,
  conversationId: uuid.nullable(),
  messageId: uuid.nullable(),
  actions: z.array(
    z.object({
      kind: z.enum([
        'book',
        'reschedule',
        'cancel',
        'book_series',
        'waitlist',
        'add_to_visit',
        ...MONEY_DRAFT_ACTIONS,
      ]),
      /** The visit it made or changed (the first of a series); null for a waitlist place or money. */
      appointmentId: uuid.nullable(),
    }),
  ),
  /** It had gone out already (a retry). */
  duplicate: z.boolean(),
});

// ---------- qualifying ----------

export const LeadRecordAnswersInput = z.object({
  workspaceId: uuid,
  leadId: uuid,
  answers: z
    .array(
      z.object({
        questionId: z.string().trim().min(1).max(40),
        answer: z.string().trim().min(1).max(500),
      }),
    )
    .min(1)
    .max(10),
});
export const LeadRecordAnswersOutput = z.object({
  leadId: uuid,
  status: qualificationStatus,
  missing: z.array(z.string()),
  notAFit: z.array(z.string()),
  /** It qualified just now (`lead.qualified` went out). */
  qualified: z.boolean(),
  /** `answers.<questionId>` for each answer a newer one to the same question beat (M10). */
  notApplied,
});

// ---------- conversations: who answers ----------

export const ConversationHandOffInput = z.object({
  workspaceId: uuid,
  conversationId: uuid,
  reason: conversationHandoffReason,
  /** For whoever picks it up. */
  note: z.string().trim().max(500).nullable().optional(),
});
export const ConversationHandOffOutput = z.object({
  conversationId: uuid,
  assigneeUserId: uuid.nullable(),
  needsPersonSince: isoDateTime,
});
export const ConversationTakeOverOutput = z.object({
  conversationId: uuid,
  draftCancelled: z.boolean(),
});
export const ConversationHandToAiOutput = z.object({ conversationId: uuid, teammateId: uuid });

// ---------- booking for the customer in the conversation ----------

const clientId = z.string().trim().min(1).max(64);

export const AppointmentBookForCustomerInput = z.object({
  workspaceId: uuid,
  /** One of the teammate's calendars (its settings in the database decide, not this input). */
  calendarId: uuid,
  startsAt: isoDateTime,
  serviceId: uuid.nullable().optional(),
  durationMinutes: z.int().min(5).max(720).optional(),
  sessionId: uuid.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  /** The customer's ZIP, for a calendar that routes by ZIP. */
  postalCode: z.string().trim().max(20).nullable().optional(),
  point: GeoPointInput.nullable().optional(),
  /** Its idempotency key: a retry books once. */
  clientId,
});
export const AppointmentBookForCustomerOutput = AppointmentBookOnlineOutput;
export const SeriesBookForCustomerInput = z.object({
  workspaceId: uuid,
  calendarId: uuid,
  /** The first visit: a time the calendar offers. The rest follow the repeat and are skipped when they don't fit. */
  startsAt: isoDateTime,
  serviceId: uuid.nullable().optional(),
  durationMinutes: z.int().min(5).max(720).optional(),
  every: repeatEvery,
  interval: z.int().min(1).max(12).default(1),
  /** How many visits, the first included (the calendar's own limit caps it). */
  times: z.int().min(2).max(52),
  notes: z.string().trim().max(2000).nullable().optional(),
  postalCode: z.string().trim().max(20).nullable().optional(),
  point: GeoPointInput.nullable().optional(),
  clientId,
});
export const SeriesBookForCustomerOutput = z.object({
  seriesId: uuid,
  appointmentIds: z.array(uuid),
  skipped: z.array(z.object({ date: z.string(), startsAt: isoDateTime, reason: z.string() })),
  duplicate: z.boolean(),
});
// ---------- a chat visitor proves who they are (M18) ----------

export const ChatSendCodeForCustomerInput = z.object({
  workspaceId: uuid,
  /** The worker can text right now (a number and balance); when not, the code goes to the email on file. */
  canText: z.boolean().default(true),
});
export const ChatSendCodeForCustomerOutput = z.object({
  codeId: uuid,
  channel: z.enum(['sms', 'email']),
  /** Where it went, masked for the chat ("•••• 42", "d•••@example.com"). */
  sentTo: z.string(),
  /** The code, for the worker to send and nothing else: never stored, never logged. */
  code: z.string().regex(/^\d{6}$/),
  /** What it goes to: the phone or email on file. */
  to: z.string(),
});
export const ChatCheckCodeForCustomerInput = z.object({
  workspaceId: uuid,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Six digits.'),
});
/** A wrong code isn't an error: the try it used has to be kept, so it answers `verified: false`. */
export const ChatCheckCodeForCustomerOutput = z.object({
  verified: z.boolean(),
  /** Tries left on this code; 0 means send a new one. */
  triesLeft: z.int().min(0),
});

// ---------- money the teammate asks for (M18) ----------

export const InvoiceCreateForCustomerInput = z.object({
  workspaceId: uuid,
  title: z.string().trim().min(1).max(200).nullable().default(null),
  lines: z.array(CatalogueLine).min(1).max(20),
});
export const EstimateCreateForCustomerInput = InvoiceCreateForCustomerInput;
export const EstimateAnswerForCustomerInput = z.object({
  workspaceId: uuid,
  estimateId: uuid,
  accepted: z.boolean(),
  /** Who said it, as they gave their name. */
  name: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(1000).nullable().optional(),
});
export const SubscriptionStartForCustomerInput = z.object({ workspaceId: uuid, planId: uuid });

export const WaitlistJoinForCustomerInput = z
  .object({
    workspaceId: uuid,
    calendarId: uuid,
    /** A full session; or leave it out and give the window they want. */
    appointmentId: uuid.nullable().optional(),
    wantedFrom: isoDateTime.nullable().optional(),
    wantedTo: isoDateTime.nullable().optional(),
  })
  .refine((v) => !!v.appointmentId || (!!v.wantedFrom && !!v.wantedTo), {
    path: ['appointmentId'],
    error: 'Pick a session, or the times they want.',
  });
export const WaitlistJoinForCustomerOutput = z.object({
  entryId: uuid,
  position: z.int(),
  /** They were already waiting for this; nothing new was added. */
  alreadyWaiting: z.boolean(),
});
export const AttendeeRescheduleForCustomerInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  startsAt: isoDateTime,
  sessionId: uuid.nullable().optional(),
});
export const AttendeeRescheduleForCustomerOutput = AttendeeRescheduleOnlineOutput;
export const AttendeeCancelForCustomerInput = z.object({
  workspaceId: uuid,
  appointmentId: uuid,
  reason: z.string().trim().max(300).nullable().optional(),
});
export const AttendeeCancelForCustomerOutput = AttendeeCancelOnlineOutput;

/** M18: more on one of the customer's visits. At least one of the three. */
export const AppointmentAddForCustomerInput = z
  .object({
    workspaceId: uuid,
    appointmentId: uuid,
    /** Another service on the calendar: the visit runs its length longer, at its price today. */
    serviceId: uuid.nullable().optional(),
    /** More people coming, on a visit with seats left. */
    guests: z.int().min(1).max(10).nullable().optional(),
    /** For the team: a gate code, pets, what's wrong, who's coming. */
    note: z.string().trim().min(1).max(1000).nullable().optional(),
  })
  .refine((v) => !!v.serviceId || !!v.guests || !!v.note, {
    error: 'Add a service, people or a note.',
  });
export const AppointmentAddForCustomerOutput = z.object({
  appointmentId: uuid,
  endsAt: isoDateTime,
  /** The services added to this visit so far. */
  services: z.array(
    z.object({ name: z.string(), durationMinutes: z.int(), priceCents: z.int().nullable() }),
  ),
  seats: z.int(),
  noteAdded: z.boolean(),
});

// ---------- queries ----------

const IssueFix = z.union([
  z.object({ id: z.string(), label: z.string(), patch: z.record(z.string(), z.unknown()) }),
  z.object({ id: z.string(), label: z.string(), href: z.string() }),
]);
export const TeammateIssueOut = z.object({
  code: z.enum(TEAMMATE_ISSUE_CODES),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  fields: z.array(z.string()),
  fixes: z.array(IssueFix),
});

/** TeammateCatalogs (ai-team/catalogs.ts) as the API returns them. */
export const TeammateCatalogsOut = z.object({
  timeZone: z.string(),
  textingReady: z.boolean(),
  emailAddresses: z.array(z.object({ id: uuid, address: z.string() })),
  chatWidgets: z.array(z.object({ id: uuid, name: z.string() })),
  calendars: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      archived: z.boolean(),
      bookableOnline: z.boolean(),
      color: z.string(),
      /** Visit lengths in minutes. */
      lengths: z.array(z.int()),
    }),
  ),
  knowledge: z.object({ published: z.int() }),
  profile: z.object({ filled: z.int(), total: z.int() }),
  /** The business profile lets the AI quote prices. */
  pricesAllowed: z.boolean(),
  /** Today's AI tokens against the daily limit, and the teammate's part (see TeammateAiUsage). */
  aiUsage: z.object({ dailyTokens: z.int(), usedTokens: z.int(), teammateTokens: z.int() }),
  businessHours: WeeklyHours.nullable(),
  members: z.array(
    z.object({ userId: uuid, name: z.string(), role: workspaceRole, active: z.boolean() }),
  ),
  newLeadTextWorkflows: z.array(z.object({ id: uuid, name: z.string() })),
  quietHours: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }),
  industry: z.string().nullable().optional(),
  pipelines: z
    .array(
      z.object({
        id: uuid,
        name: z.string(),
        archived: z.boolean(),
        stages: z.array(z.object({ id: uuid, name: z.string(), archived: z.boolean() })),
      }),
    )
    .optional(),
});

export const TeammateOut = z.object({
  id: uuid,
  name: z.string(),
  status: teammateStatus,
  /** A TeammateConfig with every default filled in. */
  config: z.record(z.string(), z.unknown()),
  configVersion: z.int(),
  revision: z.int(),
  labels: z.array(z.string()),
  trainingStartedAt: isoDateTime.nullable(),
  automaticSince: isoDateTime.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export const TeammateRevisionOut = z.object({
  revision: z.int(),
  labels: z.array(z.string()),
  diffSummary: z.array(z.string()),
  changedBy: UserRef,
  createdAt: isoDateTime,
});

export const AiTeammateGetInput = z.object({ workspaceId: uuid });
export const AiTeammateGetOutput = z.object({
  /** null until someone sets one up. */
  teammate: TeammateOut.nullable(),
  issues: z.array(TeammateIssueOut),
  progress: TeammateProgress.nullable(),
  /** Newest first, at most 50. */
  revisions: z.array(TeammateRevisionOut),
  catalogs: TeammateCatalogsOut,
  canManage: z.boolean(),
});

export const draftStatus = z.enum(['pending', 'approved', 'rejected', 'expired', 'cancelled']);
export const TeammateDraftOut = z.object({
  id: uuid,
  kind: z.enum(['reply', 'approval']),
  status: draftStatus,
  teammate: z.object({ id: uuid, name: z.string() }),
  runId: uuid.nullable(),
  conversationId: uuid.nullable(),
  channel: z.string().nullable(),
  person: z.object({ id: uuid, fullName: z.string() }).nullable(),
  lead: z.object({ id: uuid, title: z.string() }).nullable(),
  preview: TeammateDraftPreview,
  edits: TeammateDraftEdits.nullable(),
  reason: z.string().nullable(),
  decidedBy: UserRef,
  decidedAt: isoDateTime.nullable(),
  via: z.string().nullable(),
  expiresAt: isoDateTime.nullable(),
  createdAt: isoDateTime,
  /** Reply drafts: anyone who works the inbox. Approval drafts: owners and admins. */
  canDecide: z.boolean(),
  /** The knowledge its run used ({itemId, title} each), as the run recorded it. */
  knowledge: z.array(z.unknown()),
});
export type TeammateDraftOut = z.infer<typeof TeammateDraftOut>;
export const AiTeammateDraftListInput = ListInput.extend({
  workspaceId: uuid,
  /** pending: waiting for someone, oldest first; decided or all: newest first. */
  status: z.enum(['pending', 'decided', 'all']).default('pending'),
  kind: z.enum(['reply', 'approval']).optional(),
  conversationId: uuid.optional(),
});
export const AiTeammateDraftListOutput = z.object({
  items: z.array(TeammateDraftOut),
  nextCursor: z.string().nullable(),
});

/** ai_teammate_tool_calls.status (the database checks the same list). */
export const TOOL_CALL_STATUSES = [
  'running',
  'done',
  'held',
  'simulated',
  'refused',
  'failed',
] as const;

export const TeammateRunOut = z.object({
  id: uuid,
  triggeredBy: z.string(),
  status: z.enum(['running', 'done', 'superseded', 'failed']),
  outcome: z.enum(['replied', 'drafted', 'handed_off', 'no_reply']).nullable(),
  isTest: z.boolean(),
  conversationId: uuid.nullable(),
  /** The conversation's channel, or its draft's for a first message (no conversation until it's sent). */
  channel: z.enum(['sms', 'email', 'chat']).nullable(),
  person: z.object({ id: uuid, fullName: z.string() }).nullable(),
  leadId: uuid.nullable(),
  /** The customer's message that started it (the first it answered), cut short; null when none did. */
  firstMessage: z.object({ excerpt: z.string(), at: isoDateTime }).nullable(),
  /** How many of the customer's messages it answered together. */
  messageCount: z.int(),
  summary: z.string().nullable(),
  replyText: z.string().nullable(),
  knowledge: z.array(z.unknown()),
  checks: z.array(z.unknown()),
  /** The tools it used, in order. */
  tools: z.array(z.string()),
  /** Each tool call, in order: how it went and a short summary of what came back. */
  toolCalls: z.array(
    z.object({
      tool: z.string(),
      /** held: a booking, move or cancellation waiting for the reply to go out (or its draft's approval). */
      status: z.enum(TOOL_CALL_STATUSES),
      summary: z.string().nullable(),
      at: isoDateTime,
    }),
  ),
  model: z.string().nullable(),
  inputTokens: z.int(),
  outputTokens: z.int(),
  toolSteps: z.int(),
  error: z.string().nullable(),
  startedAt: isoDateTime,
  endedAt: isoDateTime.nullable(),
});
/** Activity's periods: today, or the last 7 or 30 days (in the business's time zone). */
export const ACTIVITY_PERIODS = ['today', '7d', '30d'] as const;
export const AiTeammateActivityInput = ListInput.extend({
  workspaceId: uuid,
  /** Only runs that started in this period; every run when left out. */
  since: z.enum(ACTIVITY_PERIODS).optional(),
});
export const AiTeammateActivityOutput = z.object({
  /** Today in the business's time zone, plus what's waiting now. */
  counters: z.object({
    runsToday: z.int(),
    /** Today's runs whose reply went out: on its own, or as a draft someone approved and it sent. */
    repliedToday: z.int(),
    /** Today's runs whose draft hasn't gone out: still waiting, rejected or expired. */
    draftedToday: z.int(),
    handedOffToday: z.int(),
    failedToday: z.int(),
    /** Today's runs whose booking went out: a book call that held or ran, then sent (or its draft sent). */
    bookedToday: z.int(),
    pendingDrafts: z.int(),
    needsPerson: z.int(),
    handledByAi: z.int(),
  }),
  runs: z.array(TeammateRunOut),
  nextCursor: z.string().nullable(),
});
