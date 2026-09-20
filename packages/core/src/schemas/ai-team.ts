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
    z.object({ kind: z.enum(['book', 'reschedule', 'cancel']), appointmentId: uuid }),
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
  /** Its idempotency key: a retry books once. */
  clientId,
});
export const AppointmentBookForCustomerOutput = AppointmentBookOnlineOutput;
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
