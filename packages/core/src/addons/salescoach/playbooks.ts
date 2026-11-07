/**
 * Sales Coach's playbooks: what the coach says from (docs/salescoach.md). Browser-safe: the web, the phone, the API
 * and the worker read the same shapes and limits.
 *
 * A playbook is one kind of call (a first call, going over an estimate, a follow-up) and holds:
 * - **Script steps**, in order: what the rep does at that point and, if they like, the words to say.
 * - **Objections** the customer may raise ("It's too expensive"), each with the business's answer.
 * - **Talking points**: facts the rep can lean on (the warranty, what's included, how soon they can come).
 *
 * The coach only ever says what's here and what the business's knowledge base says; it never makes up a price, a
 * promise or a fact. A call uses the playbook for how it started (a booked call, a new lead, an older lead or a cold
 * call: ./method.ts `callKindFor`), else the business's usual one.
 *
 * A step names the stage of the question-led method it belongs to (./method.ts), when it has one: the builder writes
 * every step that way, and a script a business pasted keeps the stages that fit it.
 */
import { z } from 'zod';
import { SALES_BRIEF_KEYS, SALES_BRIEF_MAX, SALES_STAGES, type SalesBriefKey } from './method';

/**
 * The kinds of call. The builder writes the first four (./method.ts `BUILDER_KINDS`), each with its own opening;
 * the rest are the kinds from before, kept for the scripts written as them.
 */
export const PLAYBOOK_KINDS = [
  'new_lead',
  'booked_call',
  'aged_lead',
  'cold_call',
  'first_call',
  'estimate',
  'follow_up',
  'any',
] as const;
export type PlaybookKind = (typeof PLAYBOOK_KINDS)[number];

/** How each kind reads on the screens. */
export const PLAYBOOK_KIND_LABELS: Readonly<Record<PlaybookKind, string>> = {
  new_lead: 'New lead who asked us to call',
  booked_call: 'Booked call',
  aged_lead: 'Older lead',
  cold_call: 'Cold call',
  first_call: 'First call',
  estimate: 'Going over an estimate',
  follow_up: 'Follow-up',
  any: 'Any call',
};

export const PLAYBOOK_LIMITS = {
  name: 80,
  steps: 20,
  stepTitle: 80,
  stepSay: 600,
  /** How to say a step: "slow down", "sound curious". */
  stepTip: 160,
  objections: 40,
  objection: 160,
  answer: 800,
  points: 40,
  topic: 80,
  fact: 600,
  /** A script someone pastes for the AI to turn into a playbook. */
  pastedScript: 30_000,
} as const;

/** A part's own short id within its playbook (`s1`, `o3`): what the coach names when it says which one fits. */
const partId = z.string().regex(/^[a-z][0-9]{1,3}$/);
const words = (max: number) => z.string().trim().max(max);
const needed = (max: number, what: string) =>
  z.string().trim().min(1, `Write the ${what}.`).max(max, `Keep the ${what} to ${max} characters.`);

export const PlaybookStep = z.object({
  id: partId,
  title: needed(PLAYBOOK_LIMITS.stepTitle, 'step'),
  say: words(PLAYBOOK_LIMITS.stepSay).default(''),
  /** The method's stage it belongs to; null for a step that fits none (a script written before, or pasted). */
  stage: z.enum(SALES_STAGES).nullable().default(null),
  /** How to say it, when that matters: "Slow down here", "Sound curious, not surprised". */
  tip: words(PLAYBOOK_LIMITS.stepTip).default(''),
});
export type PlaybookStep = z.infer<typeof PlaybookStep>;

export const PlaybookObjection = z.object({
  id: partId,
  objection: needed(PLAYBOOK_LIMITS.objection, 'objection'),
  answer: needed(PLAYBOOK_LIMITS.answer, 'answer'),
});
export type PlaybookObjection = z.infer<typeof PlaybookObjection>;

export const PlaybookPoint = z.object({
  id: partId,
  topic: needed(PLAYBOOK_LIMITS.topic, 'topic'),
  fact: needed(PLAYBOOK_LIMITS.fact, 'fact'),
});
export type PlaybookPoint = z.infer<typeof PlaybookPoint>;

const StepList = z
  .array(PlaybookStep)
  .max(PLAYBOOK_LIMITS.steps, `A playbook has ${PLAYBOOK_LIMITS.steps} steps at most.`);
const ObjectionList = z
  .array(PlaybookObjection)
  .max(
    PLAYBOOK_LIMITS.objections,
    `A playbook has ${PLAYBOOK_LIMITS.objections} objections at most.`,
  );
const PointList = z
  .array(PlaybookPoint)
  .max(PLAYBOOK_LIMITS.points, `A playbook has ${PLAYBOOK_LIMITS.points} talking points at most.`);

export const PlaybookDetails = z.object({
  steps: StepList.default([]),
  objections: ObjectionList.default([]),
  points: PointList.default([]),
});
export type PlaybookDetails = z.infer<typeof PlaybookDetails>;

/**
 * A change to a playbook's details: each list given replaces the playbook's own, and a list left out is kept as it is,
 * so changing its objections never empties its steps.
 */
export const PlaybookDetailsChange = z.object({
  steps: StepList.optional(),
  objections: ObjectionList.optional(),
  points: PointList.optional(),
});
export type PlaybookDetailsChange = z.infer<typeof PlaybookDetailsChange>;

/** A playbook's details with a change made: the lists given in place of its own (none for a new one). */
export const changedPlaybook = (
  was: PlaybookDetails | null,
  change: PlaybookDetailsChange | undefined,
): PlaybookDetails =>
  renumberPlaybook({
    steps: change?.steps ?? was?.steps ?? [],
    objections: change?.objections ?? was?.objections ?? [],
    points: change?.points ?? was?.points ?? [],
  });

export const blankPlaybook = (): PlaybookDetails => ({ steps: [], objections: [], points: [] });

/**
 * The parts numbered again in order (`s1`, `s2`…; `o1`…; `p1`…), so ids stay short however often parts come and go.
 * What the coach said about an old id on a finished call is kept as words, not ids, so nothing points at them.
 */
export function renumberPlaybook(d: PlaybookDetails): PlaybookDetails {
  return {
    steps: d.steps.map((s, i) => ({ ...s, id: `s${i + 1}` })),
    objections: d.objections.map((o, i) => ({ ...o, id: `o${i + 1}` })),
    points: d.points.map((p, i) => ({ ...p, id: `p${i + 1}` })),
  };
}

/** Whether a playbook has anything for the coach to say from. */
export const playbookIsEmpty = (d: PlaybookDetails): boolean =>
  d.steps.length + d.objections.length + d.points.length === 0;

const uuid = z.uuid();
const name = needed(PLAYBOOK_LIMITS.name, 'playbook’s name');

export const Playbook = z.object({
  id: uuid,
  name: z.string(),
  kind: z.enum(PLAYBOOK_KINDS),
  isDefault: z.boolean(),
  details: PlaybookDetails,
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Playbook = z.infer<typeof Playbook>;

export const PlaybookListInput = z.object({
  workspaceId: uuid,
  /** Only this one, whole (the Assistant reads a long list briefly, then one playbook at a time). */
  playbookId: uuid.optional(),
});
export const PlaybookListOutput = z.object({ playbooks: z.array(Playbook) });

/**
 * A new playbook, or a change to one: on a change, whatever is left out stays as it is (its name, its kind, and each
 * list of its details), so making it the usual one needs only `isDefault`.
 */
export const PlaybookSaveInput = z
  .object({
    workspaceId: uuid,
    /** Absent: a new playbook. */
    playbookId: uuid.optional(),
    /** Needed for a new one. */
    name: name.optional(),
    /** A new one left without: Any call. */
    kind: z.enum(PLAYBOOK_KINDS).optional(),
    /** Make it the usual one: what a call uses when no playbook is for how it started. */
    isDefault: z.boolean().optional(),
    details: PlaybookDetailsChange.optional(),
  })
  .refine((i) => i.playbookId !== undefined || i.name !== undefined, {
    message: 'Write the playbook’s name.',
    path: ['name'],
  });
export type PlaybookSaveInput = z.infer<typeof PlaybookSaveInput>;

export const PlaybookArchiveInput = z.object({
  workspaceId: uuid,
  playbookId: uuid,
  archived: z.boolean(),
});

/** The owner's answers to the builder's questions (./method.ts `SALES_BRIEF_QUESTIONS`), any of them blank. */
const briefAnswer = z
  .string()
  .trim()
  .max(SALES_BRIEF_MAX, `Keep each answer to ${SALES_BRIEF_MAX} characters.`)
  .default('');
export const SalesBrief = z.object({
  offer: briefAnswer,
  buyers: briefAnswer,
  problems: briefAnswer,
  result: briefAnswer,
  why: briefAnswer,
  nextStep: briefAnswer,
} satisfies Record<SalesBriefKey, typeof briefAnswer>);
export type SalesBrief = z.infer<typeof SalesBrief>;

export const blankBrief = (): SalesBrief =>
  Object.fromEntries(SALES_BRIEF_KEYS.map((k) => [k, ''])) as SalesBrief;

/** Asking the AI what it can already answer of the builder's questions, from what HandsFreeOS knows. */
export const SalesBriefGuessInput = z.object({});
export const SalesBriefGuessOutput = z.object({ brief: SalesBrief });
export type SalesBriefGuessOutput = z.infer<typeof SalesBriefGuessOutput>;

/**
 * Asking the AI for a playbook to start from: written in the question-led way from what HandsFreeOS knows about the
 * business and the owner's answers (`brief`), or from a script the owner pasted (or a document of theirs, read as
 * text). Nothing is saved; the owner edits it and saves.
 */
export const PlaybookDraftInput = z.object({
  kind: z.enum(PLAYBOOK_KINDS).default('new_lead'),
  /** The owner's answers to the builder's questions. */
  brief: SalesBrief.optional(),
  script: z
    .string()
    .trim()
    .max(
      PLAYBOOK_LIMITS.pastedScript,
      `That script is too long to read at once. Paste up to ${PLAYBOOK_LIMITS.pastedScript.toLocaleString('en-US')} characters.`,
    )
    .optional(),
  /** One of the business's files to read the script from (a PDF or a Word document). */
  fileId: uuid.optional(),
});
export type PlaybookDraftInput = z.infer<typeof PlaybookDraftInput>;
export const PlaybookDraftOutput = z.object({
  name: z.string(),
  details: PlaybookDetails,
});
export type PlaybookDraftOutput = z.infer<typeof PlaybookDraftOutput>;
