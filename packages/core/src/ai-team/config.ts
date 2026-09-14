/**
 * The AI teammate's settings document (`TeammateConfig`, version 1). One teammate per business: skills that
 * switch on and off (reply to leads, answer questions, qualify, book, follow up) on the channels it works,
 * within its hours, autonomy, limits and hand-off rules. Presets only prefill it. Browser-safe, so the
 * builder validates with the same schema the server saves with.
 *
 * Not in here, on purpose: the status (off, training, automatic) and the training-wheels counts. They live
 * on the `ai_teammates` row and only a database function changes them, so restoring a revision never
 * resets progress.
 */
import { z } from 'zod';
import { mergePatch, WeeklyHours } from '../calendar/config';
import { NotifyWho } from '../workflows/actions';

export const TEAMMATE_CONFIG_VERSION = 1;

const id = z.uuid();
const uniqueList = (list: readonly string[]) => new Set(list).size === list.length;
const uniqueWords = (list: readonly string[]) =>
  new Set(list.map((s) => s.toLowerCase())).size === list.length;

export const TEAMMATE_CHANNELS = ['sms', 'email', 'chat'] as const;
export type TeammateChannel = (typeof TEAMMATE_CHANNELS)[number];

export const TEAMMATE_SKILLS = ['respond', 'answer', 'qualify', 'book', 'followUp'] as const;
export type TeammateSkill = (typeof TEAMMATE_SKILLS)[number];

// ---- Identity ----

export const DISCLOSURE_MODES = ['first_message', 'when_asked'] as const;
export type DisclosureMode = (typeof DISCLOSURE_MODES)[number];

const Identity = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name your teammate.')
    .max(40, 'Keep it under 40 characters.')
    .default('Ava'),
  /** Says it's AI in its first message, or only when asked. Either way it never claims to be a person. */
  disclosure: z.enum(DISCLOSURE_MODES).default('first_message'),
  /** How it signs texts and emails; empty uses the business profile's signature. */
  signature: z.string().trim().max(120).default(''),
  /** Voice notes on top of the business profile's tone of voice. */
  toneNote: z.string().trim().max(300).default(''),
});

// ---- Channels ----

const Channels = z.object({
  sms: z.boolean().default(true),
  email: z.boolean().default(true),
  chat: z.boolean().default(false),
  /** The address it emails from. */
  emailAddressId: id.nullable().default(null),
  /** The website chat widget it answers. */
  widgetId: id.nullable().default(null),
});

// ---- Skills ----

const Respond = z.object({
  /** Replies to leads who write in. */
  enabled: z.boolean().default(true),
  /** Messages new leads first: a text when consent allows it, otherwise an email. */
  newLeads: z
    .object({
      enabled: z.boolean().default(true),
      channel: z.enum(['sms', 'email']).default('sms'),
      /** How long after the lead comes in. */
      delayMinutes: z.int().min(0).max(120, 'At most 2 hours.').default(1),
    })
    .prefault({}),
});

export const UNSURE_ACTIONS = ['hand_off', 'take_message'] as const;
export type UnsureAction = (typeof UNSURE_ACTIONS)[number];

const Answer = z.object({
  /** Answers questions from the knowledge base. */
  enabled: z.boolean().default(true),
  /** A question the knowledge doesn't answer: hand to a person, or say someone will follow up and leave a task. */
  whenUnsure: z.enum(UNSURE_ACTIONS).default('hand_off'),
});

export const QUESTION_KINDS = ['text', 'choice', 'yes_no', 'number'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

const choiceText = z.string().trim().min(1).max(100);

export const NotAFitIf = z.object({
  /** choice and yes/no: answers that rule the lead out ('yes' or 'no' for a yes/no question). */
  answers: z
    .array(choiceText)
    .max(20)
    .default(() => []),
  /** number: an answer below this rules the lead out. */
  below: z.number().nullable().default(null),
  /** number: an answer above this rules the lead out. */
  above: z.number().nullable().default(null),
});
export type NotAFitIf = z.infer<typeof NotAFitIf>;

export const QualifyingQuestion = z
  .object({
    id: z.string().trim().min(1).max(40),
    question: z.string().trim().min(1, 'Write the question.').max(200),
    kind: z.enum(QUESTION_KINDS).default('text'),
    /** choice: what they can pick from. */
    options: z
      .array(choiceText)
      .max(20)
      .default(() => []),
    /** Needed before the lead counts as qualified. */
    required: z.boolean().default(true),
    notAFitIf: NotAFitIf.prefault({}),
  })
  .superRefine((q, ctx) => {
    const add = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const { answers, below, above } = q.notAFitIf;
    if (q.kind === 'choice' && q.options.length < 2) add('Add at least two choices.', ['options']);
    if (!uniqueWords(q.options)) add('Each choice once.', ['options']);
    if (q.kind === 'choice' && answers.some((a) => !q.options.includes(a)))
      add('Pick from the choices.', ['notAFitIf', 'answers']);
    if (
      q.kind === 'yes_no' &&
      (answers.length > 1 || answers.some((a) => a !== 'yes' && a !== 'no'))
    )
      add('Pick yes or no.', ['notAFitIf', 'answers']);
    if ((q.kind === 'text' || q.kind === 'number') && answers.length)
      add('Only choice and yes/no questions rule a lead out by its answer.', [
        'notAFitIf',
        'answers',
      ]);
    if (q.kind !== 'number' && (below !== null || above !== null))
      add('Only number questions have a range.', ['notAFitIf']);
    if (below !== null && above !== null && below > above)
      add('The low end is above the high end.', ['notAFitIf', 'above']);
  });
export type QualifyingQuestion = z.infer<typeof QualifyingQuestion>;
export type QualifyingQuestionInput = z.input<typeof QualifyingQuestion>;

const Qualify = z.object({
  enabled: z.boolean().default(false),
  questions: z
    .array(QualifyingQuestion)
    .max(10, 'At most 10 questions.')
    .refine((list) => uniqueList(list.map((q) => q.id)), {
      error: 'Each question needs its own id.',
    })
    .default(() => []),
  /** When every required answer is in and none rules the lead out (`lead.qualified`). */
  whenQualified: z
    .object({
      /** Move the lead to this stage; null leaves it where it is. */
      stageId: id.nullable().default(null),
      /** Who hears about it; null tells no one. */
      notify: NotifyWho.nullable().default(null),
    })
    .prefault({}),
});

const Book = z.object({
  enabled: z.boolean().default(false),
  /** The only calendars it may book on; the booking commands check this list again. */
  calendarIds: z
    .array(id)
    .max(20)
    .refine(uniqueList, { error: 'Each calendar once.' })
    .default(() => []),
  reschedule: z.boolean().default(true),
  cancel: z.boolean().default(true),
});

const FollowUp = z.object({
  /** Nudges a lead who stops replying. */
  enabled: z.boolean().default(false),
  maxNudges: z.int().min(1).max(5).default(2),
});

// ---- Hours ----

export const HOURS_MODES = ['always', 'after_hours', 'custom'] as const;
export type HoursMode = (typeof HOURS_MODES)[number];

const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

const Hours = z
  .object({
    /** always; after_hours: only while the business is closed; custom: the hours below. */
    mode: z.enum(HOURS_MODES).default('always'),
    /** custom: when it works, in the workspace's time zone. */
    custom: WeeklyHours.default(() => WEEKDAYS_9_TO_5.map((h) => ({ ...h }))),
  })
  .refine((h) => h.mode !== 'custom' || h.custom.length > 0, {
    error: 'Add the hours it works.',
    path: ['custom'],
  });

// ---- Autonomy, limits, money ----

export const APPROVALS_NEEDED_MIN = 5;
export const APPROVALS_NEEDED_MAX = 200;

const Autonomy = z.object({
  /** Training wheels: approvals before it turns automatic. The counts live on the teammate, not here. */
  approvalsNeeded: z
    .int()
    .min(APPROVALS_NEEDED_MIN, `At least ${APPROVALS_NEEDED_MIN}.`)
    .max(APPROVALS_NEEDED_MAX, `At most ${APPROVALS_NEEDED_MAX}.`)
    .default(20),
  /** A draft nobody decides in this long hands the conversation to a person. */
  draftExpiresMinutes: z.int().min(15).max(1440).default(120),
});

const Limits = z.object({
  repliesPerConversationPerDay: z.int().min(1).max(50).default(12),
  /** Tool steps per reply; past it, it stops and hands off. */
  toolRounds: z.int().min(1).max(12).default(6),
  /** The most of the business's daily AI limit it may use, so the Assistant and workflows keep working. */
  dailySharePercent: z.int().min(10).max(100).default(60),
});

const Money = z.object({
  /** never; with_approval: it may propose one and a person decides. Refunds always go to a person. */
  discounts: z.enum(['never', 'with_approval']).default('never'),
  maxPercent: z.int().min(1).max(50).default(10),
});

// ---- Hand-off ----

/** The slot in the hand-off message the worker fills with when they'll hear back. */
export const EXPECTATION_SLOT = '{expectation}';

const onlyExpectationSlot = (s: string) =>
  (s.match(/\{[^{}]*\}/g) ?? []).every((m) => m === EXPECTATION_SLOT);

const HandOff = z.object({
  /** Hand over when the customer sounds frustrated. Asking for a person always hands over. */
  onFrustration: z.boolean().default(true),
  /** Topics besides the built-in ones (legal threats, complaints, refunds, cancelling service). */
  sensitiveTopics: z
    .array(z.string().trim().min(2).max(60))
    .max(20)
    .refine(uniqueWords, { error: 'Each topic once.' })
    .default(() => []),
  notify: NotifyWho.default({ kind: 'admins' }),
  /** What the customer is told; {expectation} becomes when they'll hear back. */
  tellCustomer: z
    .string()
    .trim()
    .min(1, 'Write what the customer is told.')
    .max(300)
    .refine(onlyExpectationSlot, { error: 'Only {expectation} can be filled in.' })
    // Straight apostrophes: a curly one sends a text in the slower encoding.
    .default("Thanks for your patience. I've passed this to our team, and {expectation}."),
});

// ---- The document ----

export const TeammateConfig = z.object({
  version: z.literal(TEAMMATE_CONFIG_VERSION),
  identity: Identity.prefault({}),
  channels: Channels.prefault({}),
  respond: Respond.prefault({}),
  answer: Answer.prefault({}),
  qualify: Qualify.prefault({}),
  book: Book.prefault({}),
  followUp: FollowUp.prefault({}),
  hours: Hours.prefault({}),
  autonomy: Autonomy.prefault({}),
  limits: Limits.prefault({}),
  money: Money.prefault({}),
  handOff: HandOff.prefault({}),
});
export type TeammateConfig = z.infer<typeof TeammateConfig>;
export type TeammateConfigInput = z.input<typeof TeammateConfig>;
export type TeammateModule = Exclude<keyof TeammateConfig, 'version'>;

type Patch<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: Patch<T[K]> }
    : T;
/** A partial settings document: objects merge, arrays and null replace. */
export type TeammatePatch = Patch<Omit<TeammateConfigInput, 'version'>>;

// ---- Versions ----

export type TeammateConfigUpgrade = (doc: Record<string, unknown>) => Record<string, unknown>;

/** Step n turns a version n document into version n + 1. Version 1 is the first, so there are none yet. */
export const TEAMMATE_CONFIG_UPGRADES: Readonly<Record<number, TeammateConfigUpgrade>> = {};

export class TeammateConfigVersionError extends Error {
  constructor(readonly version: number) {
    super(`These AI teammate settings (version ${version}) are newer than this app understands.`);
    this.name = 'TeammateConfigVersionError';
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Runs the pure upgrade steps up to the current version. A document without a version is version 1. */
export function upgradeTeammateConfig(
  raw: unknown,
  steps: Readonly<Record<number, TeammateConfigUpgrade>> = TEAMMATE_CONFIG_UPGRADES,
  target: number = TEAMMATE_CONFIG_VERSION,
): Record<string, unknown> {
  let doc: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : {};
  let version = typeof doc.version === 'number' && Number.isInteger(doc.version) ? doc.version : 1;
  if (version > target) throw new TeammateConfigVersionError(version);
  while (version < target) {
    const step = steps[version];
    if (!step) throw new Error(`No upgrade from AI teammate settings version ${version}.`);
    doc = step(doc);
    version += 1;
  }
  return { ...doc, version };
}

/** Upgrades and validates a stored or submitted document, filling every default. Throws a ZodError when invalid. */
export function parseTeammateConfig(raw: unknown): TeammateConfig {
  return TeammateConfig.parse(upgradeTeammateConfig(raw));
}

/** Every setting at its default. */
export function emptyTeammateConfig(): TeammateConfig {
  return TeammateConfig.parse({ version: TEAMMATE_CONFIG_VERSION });
}

/** Applies a patch and validates the result (new list items get their defaults). Throws a ZodError when invalid. */
export function applyTeammatePatch(config: TeammateConfig, patch: TeammatePatch): TeammateConfig {
  return TeammateConfig.parse({ ...mergePatch(config, patch), version: config.version });
}

// ---- Qualifying ----

export interface QualificationResult {
  /** qualified: every required answer is in and none rules them out (`lead.qualified`). */
  readonly status: 'qualified' | 'not_a_fit' | 'incomplete';
  /** Required questions still without an answer. */
  readonly missing: readonly string[];
  /** Questions whose answer rules the lead out. */
  readonly notAFit: readonly string[];
}

const YES = /^(y|yes|yeah|yep|yup|sure|correct|true|i do|we do|i am|we are)\b/;
const NO = /^(n|no|nope|nah|false|not really|i don't|i do not|we don't|we do not)\b/;

function yesNo(answer: string): 'yes' | 'no' | null {
  const a = answer.trim().toLowerCase().replace(/’/g, "'");
  if (NO.test(a)) return 'no';
  if (YES.test(a)) return 'yes';
  return null;
}

function numberIn(answer: string): number | null {
  const m = answer.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return /\d\s*k\b/i.test(answer) ? n * 1000 : n;
}

/**
 * Where a lead stands on the qualifying questions, from the answers recorded so far (question id →
 * the customer's answer in words). A choice matches its option ignoring case; yes/no reads "yes", "yeah",
 * "no", "nope"…; a number is the first number in the answer ("$5k" is 5000). Unknown ids are ignored.
 */
export function qualificationOf(
  questions: readonly QualifyingQuestion[],
  answers: Readonly<Record<string, string | null | undefined>>,
): QualificationResult {
  const missing: string[] = [];
  const notAFit: string[] = [];
  for (const q of questions) {
    const answer = answers[q.id]?.trim() ?? '';
    if (!answer) {
      if (q.required) missing.push(q.id);
      continue;
    }
    const rule = q.notAFitIf;
    let out = false;
    if (q.kind === 'choice') {
      const picked = q.options.find((o) => o.toLowerCase() === answer.toLowerCase());
      out = picked !== undefined && rule.answers.includes(picked);
    } else if (q.kind === 'yes_no') {
      const yn = yesNo(answer);
      out = yn !== null && rule.answers.includes(yn);
    } else if (q.kind === 'number') {
      const n = numberIn(answer);
      out =
        n !== null &&
        ((rule.below !== null && n < rule.below) || (rule.above !== null && n > rule.above));
    }
    if (out) notAFit.push(q.id);
  }
  const status = notAFit.length ? 'not_a_fit' : missing.length ? 'incomplete' : 'qualified';
  return { status, missing, notAFit };
}
