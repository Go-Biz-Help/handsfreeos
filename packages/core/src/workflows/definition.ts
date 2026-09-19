/**
 * The workflow definition (`WorkflowDefinition`, version 1): one tree that the step list, the canvas and the
 * AI builder all edit, only through the patch ops in ops.ts. A trigger, then `steps[]` with stable ids; a
 * branch step holds `branches[{id, name, condition | description, steps[]}]`, and after the block the run
 * continues with the next step in the parent list. Browser-safe, so the editors validate with the same
 * schema the server saves with.
 */
import { z } from 'zod';
import { isClock } from '../calendar/engine/zoned';
import { ACTION_CONFIGS, type ActionKey } from './actions';
import { ConditionGroup, Duration, DURATION_UNITS } from './conditions';
import { BranchId, Ref, StepId } from './ids';

export const WORKFLOW_DEFINITION_VERSION = 1;

const clock = z.string().refine(isClock, { error: 'Use a time like 09:00.' });

// ---- Trigger events ----

/**
 * How the engine finds the customer a run is for:
 * - `person`: the event's entity is the person.
 * - `payload_person`: `payload.personId` (messages, calls and AI teammate hand-offs, with
 *   `payload.conversationId`; an unknown number starts no run).
 * - `lead_person`: `leads.person_id` of the event's lead.
 * - `appointment_people`: one run per person on the appointment (`payload.personIds` on booking; the
 *   attendees are re-read for the others).
 * - `task_person`: `tasks.person_id` of the event's task.
 * - `record`: the tagged person, or `leads.person_id` when a lead was tagged.
 */
export type SubjectRule =
  'person' | 'payload_person' | 'lead_person' | 'appointment_people' | 'task_person' | 'record';

export type RunRecord = 'lead' | 'appointment' | 'conversation';

export interface TriggerEventDef {
  readonly label: string;
  readonly subject: SubjectRule;
  /** Records the run knows besides the person, so their fields and variables can be used. */
  readonly provides: readonly RunRecord[];
  /** Fires often; without a filter it's flagged as a broad trigger. */
  readonly broad?: boolean;
}

export const TRIGGER_EVENTS = {
  'person.created': { label: 'A customer is added', subject: 'person', provides: [] },
  'person.updated': {
    label: 'A customer’s details change',
    subject: 'person',
    provides: [],
    broad: true,
  },
  'record.tags_changed': {
    label: 'Tags change on a customer or lead',
    subject: 'record',
    provides: [],
    broad: true,
  },
  'lead.created': { label: 'A new lead comes in', subject: 'lead_person', provides: ['lead'] },
  'lead.stage_changed': { label: 'A lead moves stage', subject: 'lead_person', provides: ['lead'] },
  'lead.assigned': { label: 'A lead is assigned', subject: 'lead_person', provides: ['lead'] },
  /** The event's entity is the lead; the AI teammate's recorded answers qualified it. */
  'lead.qualified': { label: 'A lead is qualified', subject: 'lead_person', provides: ['lead'] },
  'appointment.booked': {
    label: 'An appointment is booked',
    subject: 'appointment_people',
    provides: ['appointment'],
  },
  'appointment.rescheduled': {
    label: 'An appointment is rescheduled',
    subject: 'appointment_people',
    provides: ['appointment'],
  },
  'appointment.cancelled': {
    label: 'An appointment is cancelled',
    subject: 'appointment_people',
    provides: ['appointment'],
  },
  'appointment.completed': {
    label: 'An appointment is completed',
    subject: 'appointment_people',
    provides: ['appointment'],
  },
  'appointment.no_show': {
    label: 'A customer doesn’t show up',
    subject: 'appointment_people',
    provides: ['appointment'],
  },
  'message.received': {
    label: 'A customer sends a message',
    subject: 'payload_person',
    provides: ['conversation'],
    broad: true,
  },
  'call.missed': {
    label: 'A call is missed',
    subject: 'payload_person',
    provides: ['conversation'],
  },
  'call.voicemail_left': {
    label: 'A voicemail is left',
    subject: 'payload_person',
    provides: ['conversation'],
  },
  'call.completed': {
    label: 'A call ends',
    subject: 'payload_person',
    provides: ['conversation'],
    broad: true,
  },
  'task.completed': { label: 'A task is done', subject: 'task_person', provides: [] },
  /** The event's entity is the conversation; its payload carries personId and conversationId. */
  'ai_teammate.handed_off': {
    label: 'The AI teammate hands a conversation to a person',
    subject: 'payload_person',
    provides: ['conversation'],
  },
  /**
   * Money (M9). The event's entity is the document, so the customer comes from `payload.personId`, which every
   * one of these carries. They provide no record of their own: an estimate and an invoice are not among the
   * three a run can hold, so a message templates from the customer and the business.
   */
  'estimate.sent': { label: 'An estimate goes out', subject: 'payload_person', provides: [] },
  'estimate.accepted': {
    label: 'A customer approves an estimate',
    subject: 'payload_person',
    provides: [],
  },
  'estimate.declined': {
    label: 'A customer declines an estimate',
    subject: 'payload_person',
    provides: [],
  },
  'invoice.paid': { label: 'An invoice is paid', subject: 'payload_person', provides: [] },
  /**
   * Forms (M15). The event's entity is the form, so the customer comes from `payload.personId` — which is
   * null on an anonymous form, and a run starts for nobody, which is right: there is nobody to follow up.
   */
  'form.submitted': { label: 'Somebody answers a form', subject: 'payload_person', provides: [] },
  'invoice.overdue': { label: 'An invoice goes overdue', subject: 'payload_person', provides: [] },
} as const satisfies Record<string, TriggerEventDef>;
export type TriggerEventKey = keyof typeof TRIGGER_EVENTS;
export const TRIGGER_EVENT_KEYS = Object.keys(TRIGGER_EVENTS) as [
  TriggerEventKey,
  ...TriggerEventKey[],
];
export const TriggerEvent = z.enum(TRIGGER_EVENT_KEYS);

export function triggerEventDef(key: TriggerEventKey): TriggerEventDef {
  return TRIGGER_EVENTS[key];
}

// ---- Dates a run can be timed from ----

export const DATE_ANCHORS = {
  'appointment.starts_at': { label: 'the appointment starts', record: 'appointment' },
  'appointment.ends_at': { label: 'the appointment ends', record: 'appointment' },
  'lead.created_at': { label: 'the lead came in', record: 'lead' },
  'lead.stage_entered_at': { label: 'the lead entered its stage', record: 'lead' },
  'lead.next_action_at': { label: 'the lead’s next action is due', record: 'lead' },
  'person.created_at': { label: 'the customer was added', record: 'person' },
} as const satisfies Record<string, { label: string; record: RunRecord | 'person' }>;
export type DateAnchorKey = keyof typeof DATE_ANCHORS;
export const DateAnchor = z.enum(Object.keys(DATE_ANCHORS) as [DateAnchorKey, ...DateAnchorKey[]]);

/** "2 hours after", "1 day before", or "when" (amount 0). `at` pins a time of day for day and week offsets. */
export const DateOffset = z.object({
  amount: z.int().min(0).max(1000),
  unit: z.enum(DURATION_UNITS),
  direction: z.enum(['before', 'after']).default('after'),
});
export type DateOffset = z.infer<typeof DateOffset>;

const atFitsOffset = (v: { offset: DateOffset; at: string | null }) =>
  v.at === null || v.offset.unit === 'days' || v.offset.unit === 'weeks';
const atError = { error: 'A time of day works with days or weeks.', path: ['at'] };

// ---- Triggers ----

export const WeeklyCadence = z.object({
  every: z.literal('weekly'),
  /** 0 is Sunday. */
  days: z
    .array(z.int().min(0).max(6))
    .min(1, 'Pick a day.')
    .max(7)
    .refine((d) => new Set(d).size === d.length, { error: 'Each day once.' }),
  at: clock,
});
export const MonthlyCadence = z.object({
  every: z.literal('monthly'),
  day: z.union([z.int().min(1).max(28), z.literal('last')]),
  at: clock,
});
export const Cadence = z.discriminatedUnion('every', [WeeklyCadence, MonthlyCadence]);
export type Cadence = z.infer<typeof Cadence>;

export const EventTrigger = z.object({
  kind: z.literal('event'),
  event: TriggerEvent,
  filters: ConditionGroup.prefault({}),
});
export const ScheduleTrigger = z.object({
  kind: z.literal('schedule'),
  cadence: Cadence,
  /** Who is enrolled at each occurrence; an empty group means every customer. */
  audience: ConditionGroup.prefault({}),
});
export const DateTrigger = z
  .object({
    kind: z.literal('date'),
    anchor: DateAnchor,
    offset: DateOffset,
    at: clock.nullable().default(null),
    filters: ConditionGroup.prefault({}),
  })
  .refine(atFitsOffset, atError);
export const WebhookTrigger = z.object({
  kind: z.literal('webhook'),
  personBy: z.enum(['phone', 'email', 'phone_or_email']).default('phone_or_email'),
  createPerson: z.boolean().default(true),
});
export const ManualTrigger = z.object({ kind: z.literal('manual') });

export const Trigger = z.discriminatedUnion('kind', [
  EventTrigger,
  ScheduleTrigger,
  DateTrigger,
  WebhookTrigger,
  ManualTrigger,
]);
export type Trigger = z.infer<typeof Trigger>;
export type TriggerInput = z.input<typeof Trigger>;
export type TriggerKind = Trigger['kind'];

// ---- Steps ----

export const STEP_TYPES = ['action', 'wait', 'branch', 'ai', 'approval', 'goto', 'end'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const OnError = z.enum(['stop', 'continue']);

const actionStep = <K extends ActionKey>(action: K) =>
  z.object({
    id: StepId,
    type: z.literal('action'),
    action: z.literal(action),
    config: ACTION_CONFIGS[action],
    /** A rule refusal or a dead step: stop the run, or carry on with the next step. */
    onError: OnError.default('stop'),
  });

export const ActionStep = z.discriminatedUnion('action', [
  actionStep('send_text'),
  actionStep('send_email'),
  actionStep('update_person'),
  actionStep('add_tag'),
  actionStep('remove_tag'),
  actionStep('create_lead'),
  actionStep('move_lead_stage'),
  actionStep('assign_lead'),
  actionStep('set_next_action'),
  actionStep('create_task'),
  actionStep('complete_task'),
  actionStep('add_note'),
  actionStep('assign_conversation'),
  actionStep('close_conversation'),
  actionStep('notify_team'),
  actionStep('webhook_out'),
  actionStep('enrol_workflow'),
  actionStep('remove_from_workflow'),
  actionStep('hand_to_ai_teammate'),
  actionStep('send_form'),
]);
export type ActionStep = z.infer<typeof ActionStep>;

export const WaitUntil = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('duration'), duration: Duration }),
  /** The next time the clock reads `at` on one of `days` (the workspace's time zone). */
  z.object({
    kind: z.literal('time_of_day'),
    at: clock,
    days: z
      .array(z.int().min(0).max(6))
      .min(1)
      .max(7)
      .default(() => [0, 1, 2, 3, 4, 5, 6]),
  }),
  /** A time relative to a date on the run's records, re-read when the wait wakes. */
  z
    .object({
      kind: z.literal('date_field'),
      anchor: DateAnchor,
      offset: DateOffset,
      at: clock.nullable().default(null),
    })
    .refine(atFitsOffset, atError),
  /** Until one of these events happens for the customer, or the timeout passes (see `wait.timed_out`). */
  z.object({
    kind: z.literal('event'),
    events: z.array(TriggerEvent).min(1, 'Pick an event.').max(5),
    filter: ConditionGroup.prefault({}),
    timeout: Duration,
  }),
]);
export type WaitUntil = z.infer<typeof WaitUntil>;

export const WaitStep = z.object({ id: StepId, type: z.literal('wait'), until: WaitUntil });
export type WaitStep = z.infer<typeof WaitStep>;

export const AI_TASKS = ['write', 'classify', 'summarize'] as const;
export type AiTask = (typeof AI_TASKS)[number];
export const OUTPUT_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
const OutputKey = z.string().regex(OUTPUT_KEY_RE, { error: 'Use a short lowercase name.' });
const Category = z.string().trim().min(1).max(40);

export const AiStep = z
  .object({
    id: StepId,
    type: z.literal('ai'),
    task: z.enum(AI_TASKS),
    prompt: z.string().trim().min(1, 'Tell the AI what to do.').max(2000),
    /** classify: the categories it can pick. */
    categories: z
      .array(Category)
      .max(10)
      .default(() => []),
    /** Where the result goes (`{{ai.<key>}}`); null uses message, category or summary. */
    outputKey: OutputKey.nullable().default(null),
    /** write: the channel the text is for (length caps differ). */
    channel: z.enum(['sms', 'email']).default('sms'),
    /** Used when the AI can't answer or the daily limit is reached: a text, or a category. */
    fallback: z.string().trim().max(1600).nullable().default(null),
    useKnowledge: z.boolean().default(true),
  })
  .superRefine((s, ctx) => {
    if (s.task === 'classify' && s.categories.length < 2)
      ctx.addIssue({
        code: 'custom',
        message: 'Add at least two categories.',
        path: ['categories'],
      });
    if (new Set(s.categories.map((c) => c.toLowerCase())).size !== s.categories.length)
      ctx.addIssue({ code: 'custom', message: 'Each category once.', path: ['categories'] });
    if (s.task === 'classify' && s.fallback !== null && !s.categories.includes(s.fallback))
      ctx.addIssue({
        code: 'custom',
        message: 'Fall back to one of the categories.',
        path: ['fallback'],
      });
  });
export type AiStep = z.infer<typeof AiStep>;

export function aiOutputKey(step: Pick<AiStep, 'task' | 'outputKey'>): string {
  return (
    step.outputKey ?? { write: 'message', classify: 'category', summarize: 'summary' }[step.task]
  );
}

export const Approvers = z.discriminatedUnion('kind', [
  /** Owners and admins. */
  z.object({ kind: z.literal('admins') }),
  z.object({ kind: z.literal('users'), userIds: z.array(Ref).max(20) }),
]);
export type Approvers = z.infer<typeof Approvers>;

export const GotoStep = z.object({
  id: StepId,
  type: z.literal('goto'),
  target: StepId,
  /** How many times this go-to jumps before the run carries on past it. */
  maxVisits: z.int().min(1).max(10).default(3),
});
export type GotoStep = z.infer<typeof GotoStep>;

export const EndStep = z.object({ id: StepId, type: z.literal('end') });
export type EndStep = z.infer<typeof EndStep>;

export const BRANCH_MODES = ['if_else', 'multi', 'ai'] as const;
export type BranchMode = (typeof BRANCH_MODES)[number];
export const MAX_BRANCHES = 10;
export const MAX_LANE_STEPS = 200;

/** A branch: its checks (if/else and multi-path) or its description (AI-sorted), and its steps. */
export interface Branch {
  id: string;
  name: string;
  /** null means "otherwise" (only on the last branch). */
  condition: ConditionGroup | null;
  /** AI-sorted branches: what the AI reads to pick this path. */
  description: string | null;
  steps: Step[];
}
export interface BranchInput {
  id: string;
  name: string;
  condition?: z.input<typeof ConditionGroup> | null;
  description?: string | null;
  steps?: StepInput[];
}

export const Branch: z.ZodType<Branch, BranchInput> = z.object({
  id: BranchId,
  name: z.string().trim().min(1, 'Name the path.').max(60),
  condition: ConditionGroup.nullable().default(null),
  description: z.string().trim().min(1).max(300).nullable().default(null),
  steps: z.lazy(() => z.array(Step).max(MAX_LANE_STEPS)).default(() => []),
});

export const BranchStep = z
  .object({
    id: StepId,
    type: z.literal('branch'),
    mode: z.enum(BRANCH_MODES),
    branches: z.array(Branch).min(2, 'A branch needs two paths.').max(MAX_BRANCHES),
  })
  .superRefine((s, ctx) => {
    if (s.mode === 'if_else' && s.branches.length !== 2)
      ctx.addIssue({ code: 'custom', message: 'If/else has two paths.', path: ['branches'] });
    s.branches.forEach((b, i) => {
      const last = i === s.branches.length - 1;
      if (s.mode === 'ai' && !b.description)
        ctx.addIssue({
          code: 'custom',
          message: 'Describe when the AI picks this path.',
          path: ['branches', i, 'description'],
        });
      if (s.mode !== 'ai' && b.condition === null && !last)
        ctx.addIssue({
          code: 'custom',
          message: 'Only the last path can be “otherwise”.',
          path: ['branches', i, 'condition'],
        });
    });
  });
export type BranchStep = z.infer<typeof BranchStep>;

export interface RejectedLane {
  steps: Step[];
}
export interface RejectedLaneInput {
  steps?: StepInput[];
}
const RejectedLane: z.ZodType<RejectedLane, RejectedLaneInput> = z.object({
  steps: z.lazy(() => z.array(Step).max(MAX_LANE_STEPS)).default(() => []),
});

const ApprovalFields = z.object({
  id: StepId,
  type: z.literal('approval'),
  approvers: Approvers.default({ kind: 'admins' }),
  /** What the approver reads. */
  message: z.string().trim().max(500).default(''),
  /** The step whose output the approver sees and can edit (an AI-written text), if any. */
  previewStepId: StepId.nullable().default(null),
  expiresAfter: Duration.default({ amount: 2, unit: 'days' }),
  onExpire: z.enum(['approve', 'reject', 'end']).default('reject'),
});
export interface ApprovalStep extends z.infer<typeof ApprovalFields> {
  /** What happens when it's rejected; after these steps the run ends. */
  rejected: RejectedLane;
}
export interface ApprovalStepInput extends z.input<typeof ApprovalFields> {
  rejected?: RejectedLaneInput;
}
export const ApprovalStep = ApprovalFields.extend({
  rejected: RejectedLane.default(() => ({ steps: [] })),
});

export type Step = ActionStep | WaitStep | BranchStep | AiStep | ApprovalStep | GotoStep | EndStep;
export type StepInput =
  | z.input<typeof ActionStep>
  | z.input<typeof WaitStep>
  | z.input<typeof BranchStep>
  | z.input<typeof AiStep>
  | ApprovalStepInput
  | z.input<typeof GotoStep>
  | z.input<typeof EndStep>;

export const Step: z.ZodType<Step, StepInput> = z.lazy(() =>
  z.discriminatedUnion('type', [
    ActionStep,
    WaitStep,
    BranchStep,
    AiStep,
    ApprovalStep,
    GotoStep,
    EndStep,
  ]),
);

// ---- Settings ----

export const Reentry = z.discriminatedUnion('mode', [
  /** Once per customer, ever. */
  z.object({ mode: z.literal('once') }),
  /** Again after their last run finished. */
  z.object({ mode: z.literal('after_exit') }),
  /** Every time, at most once per cooldown. */
  z.object({ mode: z.literal('always'), cooldown: Duration.default({ amount: 1, unit: 'days' }) }),
]);
export type Reentry = z.infer<typeof Reentry>;

/**
 * What stops a run early. `estimate_accepted` (M9) is how a follow-up chain stops the moment the customer says
 * yes — the worker's dispatcher maps `estimate.accepted` onto it.
 */
export const STOP_ON = ['reply', 'booking', 'lead_won', 'lead_lost', 'estimate_accepted'] as const;
export type StopOn = (typeof STOP_ON)[number];

export const WorkflowSettings = z.object({
  reentry: Reentry.default({ mode: 'after_exit' }),
  /** The run stops when the customer replies, books, or the lead is won or lost. */
  stopOn: z
    .array(z.enum(STOP_ON))
    .max(STOP_ON.length)
    .refine((l) => new Set(l).size === l.length, { error: 'Each once.' })
    .default(() => []),
  /** A text due in quiet hours: wait for the morning, send an email instead, or skip it. */
  quietHours: z.enum(['wait', 'email_instead', 'skip']).default('wait'),
  /** A customer who hasn't agreed to texts: skip the text, or email them instead. */
  noConsent: z.enum(['skip', 'email_fallback']).default('email_fallback'),
  maxRunDays: z.int().min(1).max(365).default(90),
});
export type WorkflowSettings = z.infer<typeof WorkflowSettings>;
export type WorkflowSettingsInput = z.input<typeof WorkflowSettings>;

// ---- The definition ----

export const WorkflowDefinition = z.object({
  version: z.literal(WORKFLOW_DEFINITION_VERSION),
  trigger: Trigger,
  steps: z
    .array(Step)
    .max(MAX_LANE_STEPS)
    .default(() => []),
  settings: WorkflowSettings.prefault({}),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinition>;

// ---- Versions ----

export type DefinitionUpgrade = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Step n turns a version n definition into version n + 1. Version 1 is the first, so there are none yet. */
export const DEFINITION_UPGRADES: Readonly<Record<number, DefinitionUpgrade>> = {};

export class DefinitionVersionError extends Error {
  constructor(readonly version: number) {
    super(`This workflow (version ${version}) is newer than this app understands.`);
    this.name = 'DefinitionVersionError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Runs the pure upgrade steps up to the current version. A definition without a version is version 1. */
export function upgradeDefinition(
  raw: unknown,
  steps: Readonly<Record<number, DefinitionUpgrade>> = DEFINITION_UPGRADES,
  target: number = WORKFLOW_DEFINITION_VERSION,
): Record<string, unknown> {
  let doc: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  let version = typeof doc.version === 'number' && Number.isInteger(doc.version) ? doc.version : 1;
  if (version > target) throw new DefinitionVersionError(version);
  while (version < target) {
    const step = steps[version];
    if (!step) throw new Error(`No upgrade from workflow version ${version}.`);
    doc = step(doc);
    version += 1;
  }
  return { ...doc, version };
}

/** Upgrades and validates a stored or submitted definition, filling every default. Throws a ZodError. */
export function parseDefinition(raw: unknown): WorkflowDefinition {
  return WorkflowDefinition.parse(upgradeDefinition(raw));
}

/** A new, empty workflow (manual trigger unless one is given). */
export function blankDefinition(trigger: TriggerInput = { kind: 'manual' }): WorkflowDefinition {
  return WorkflowDefinition.parse({ version: WORKFLOW_DEFINITION_VERSION, trigger });
}
