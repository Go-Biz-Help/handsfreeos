/**
 * Quick setup's answers, its screens, and what the business keeps of them
 * (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4–§5). Browser-safe.
 *
 * - The answers are one document, `AiSetupAnswers`. Every field is picked before anyone answers
 *   (`startingAiSetupAnswers`), so a screen only ever changes what it shows.
 * - While someone is part way through, the business keeps their answers and the furthest screen they finished in
 *   `workspaces.settings.aiSetup`, written only by quick setup's own commands (`workspace.update` refuses the key).
 *   So they can stop on the computer and carry on from the phone. Finishing clears them and keeps who finished.
 * - It is read forgivingly: answers that no longer parse count as never given.
 */
import { z } from 'zod';
import { DISCLOSURE_MODES, HOURS_MODES, QualifyingQuestion } from '../ai-team/config';
import { WeeklyHours } from '../calendar/config';
import { DEFAULT_OPEN_HOURS, openHoursProblem } from '../schemas/workspace';
import { SETUP_JOBS, SETUP_KINDS, SETUP_TONES, type SetupKind } from './kinds';

export const AI_SETUP_SETTINGS_KEY = 'aiSetup';

/** The screens, in order. Two only show when they apply (`aiSetupStepApplies`). */
export const AI_SETUP_STEPS = [
  'business',
  'jobs',
  'about',
  'hours',
  'facts',
  'meet',
  'voice',
  'learned',
  'qualify',
  'loop',
  'chat',
  'try',
] as const;
export type AiSetupStep = (typeof AI_SETUP_STEPS)[number];

/** `keep`: what's written in Knowledge → Business profile isn't one of the three, and stays. */
export const AI_SETUP_TONES = [...SETUP_TONES, 'keep'] as const;
export type AiSetupTone = (typeof AI_SETUP_TONES)[number];

export const AiSetupService = z.object({
  name: z.string().trim().min(1, 'Name the service.').max(120, 'Keep it under 120 characters.'),
  description: z.string().trim().max(500, 'Keep it under 500 characters.').default(''),
});
export type AiSetupService = z.infer<typeof AiSetupService>;

/** One of "What do customers ask you most?". */
export const AiSetupTopQuestion = z.object({
  question: z.string().trim().min(1, 'Write the question.').max(300),
  answer: z.string().trim().min(1, 'Write the answer.').max(5000),
});
export type AiSetupTopQuestion = z.infer<typeof AiSetupTopQuestion>;

const WEEKDAYS_9_TO_5: WeeklyHours = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: '09:00',
  end: '17:00',
}));

const unique = (list: readonly string[]) => new Set(list).size === list.length;

const findings = z
  .array(z.uuid())
  .max(200)
  .refine(unique, { error: 'Each finding once.' })
  .default(() => []);

const hours = WeeklyHours.superRefine((h, ctx) => {
  const problem = openHoursProblem(h);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});

export const AiSetupAnswers = z.object({
  /** "What should Ava help with?" */
  jobs: z
    .array(z.enum(SETUP_JOBS))
    .max(SETUP_JOBS.length)
    .refine(unique, { error: 'Each job once.' })
    .default(() => []),
  /** "What you do", for Knowledge → Business profile. */
  description: z.string().trim().max(2000, 'Keep it under 2,000 characters.').default(''),
  services: z
    .array(AiSetupService)
    .max(50, 'At most 50 services.')
    .default(() => []),
  /** Where the business works, in its own words (cities, ZIP codes, an address, states). */
  area: z.string().trim().max(500, 'Keep it under 500 characters.').default(''),
  /** When the business is open, for Settings → Workspace and Knowledge. */
  openHours: hours.default(() => DEFAULT_OPEN_HOURS.map((h) => ({ ...h }))),
  /** When Ava answers: all the time, only while the business is closed, or at the hours below. */
  answerWhen: z.enum(HOURS_MODES).default('always'),
  customHours: hours.default(() => WEEKDAYS_9_TO_5.map((h) => ({ ...h }))),
  /** Quick facts answered, by `QuickFact.key`. One left out was skipped. */
  facts: z.record(z.string().max(40), z.enum(['yes', 'no'])).default(() => ({})),
  name: z
    .string()
    .trim()
    .min(1, 'Name your teammate.')
    .max(40, 'Keep it under 40 characters.')
    .default('Ava'),
  disclosure: z.enum(DISCLOSURE_MODES).default('first_message'),
  tone: z.enum(AI_SETUP_TONES).default('friendly'),
  /** "Can Ava tell customers your prices?" */
  allowPrices: z.boolean().default(false),
  /** "What do customers ask you most?", with the answers. */
  topQuestions: z
    .array(AiSetupTopQuestion)
    .max(3, 'At most 3.')
    .default(() => []),
  /** What the website scan found, left ticked on "What Ava learned": it goes into Knowledge, ready to use. */
  keepFindings: findings,
  /** And unticked: turned down. Findings in neither list wait in Knowledge → Suggestions. */
  dropFindings: findings,
  /** The qualifying questions, when Ava asks them. */
  questions: z
    .array(QualifyingQuestion)
    .max(10, 'At most 10 questions.')
    .refine((list) => unique(list.map((q) => q.id)), { error: 'Each question needs its own id.' })
    .default(() => []),
  /** "Add Ava to your website?" */
  chat: z.boolean().default(false),
});
export type AiSetupAnswers = z.infer<typeof AiSetupAnswers>;
export type AiSetupAnswersInput = z.input<typeof AiSetupAnswers>;

/** What each screen asks. A screen with none only shows or does things. */
export const AI_SETUP_STEP_FIELDS: Readonly<
  Record<AiSetupStep, readonly (keyof AiSetupAnswers)[]>
> = {
  business: [],
  jobs: ['jobs'],
  about: ['description', 'services', 'area'],
  hours: ['openHours', 'answerWhen', 'customHours'],
  facts: ['facts'],
  meet: ['name', 'disclosure'],
  voice: ['tone', 'allowPrices'],
  learned: ['topQuestions', 'keepFindings', 'dropFindings'],
  qualify: ['questions'],
  loop: [],
  chat: ['chat'],
  try: [],
};

/** What decides whether the optional screens show, beside the answers. */
export interface AiSetupFlowFacts {
  /** The business has a website. */
  readonly website: boolean;
  /** It has a website chat already. */
  readonly chat: boolean;
}

/** Whether a screen shows: qualifying questions only when Ava asks them, the chat only for a website without one. */
export function aiSetupStepApplies(
  step: AiSetupStep,
  answers: Pick<AiSetupAnswers, 'jobs'>,
  facts: AiSetupFlowFacts,
): boolean {
  switch (step) {
    case 'qualify':
      return answers.jobs.includes('qualify');
    case 'chat':
      return facts.website && !facts.chat;
    default:
      return true;
  }
}

/** The screens this business goes through, in order. */
export function aiSetupSteps(
  answers: Pick<AiSetupAnswers, 'jobs'>,
  facts: AiSetupFlowFacts,
): AiSetupStep[] {
  return AI_SETUP_STEPS.filter((s) => aiSetupStepApplies(s, answers, facts));
}

/** The screen after this one, or null after the last. */
export function aiSetupNextStep(
  step: AiSetupStep,
  answers: Pick<AiSetupAnswers, 'jobs'>,
  facts: AiSetupFlowFacts,
): AiSetupStep | null {
  return (
    AI_SETUP_STEPS.slice(AI_SETUP_STEPS.indexOf(step) + 1).find((s) =>
      aiSetupStepApplies(s, answers, facts),
    ) ?? null
  );
}

/** The screen before this one, or null on the first. */
export function aiSetupPreviousStep(
  step: AiSetupStep,
  answers: Pick<AiSetupAnswers, 'jobs'>,
  facts: AiSetupFlowFacts,
): AiSetupStep | null {
  return (
    AI_SETUP_STEPS.slice(0, AI_SETUP_STEPS.indexOf(step))
      .reverse()
      .find((s) => aiSetupStepApplies(s, answers, facts)) ?? null
  );
}

/** Picked from the kind of business, so they're picked again when the kind changes on the first screen. */
export const AI_SETUP_KIND_FIELDS: readonly (keyof AiSetupAnswers)[] = [
  'jobs',
  'facts',
  'tone',
  'questions',
];

/**
 * Where to carry on from: the answers given on the screens finished so far, and today's picks for the rest. A
 * draft answered for another kind of business keeps only what isn't picked by kind.
 */
export function resumeAiSetup(
  starting: AiSetupAnswers,
  record: Pick<AiSetupRecord, 'draft' | 'reached' | 'kind'>,
  kind: SetupKind,
): AiSetupAnswers {
  const { draft, reached } = record;
  if (!draft || !reached) return starting;
  const out: Record<string, unknown> = { ...starting };
  for (const step of AI_SETUP_STEPS.slice(0, AI_SETUP_STEPS.indexOf(reached) + 1))
    for (const field of AI_SETUP_STEP_FIELDS[step])
      if (record.kind === kind || !AI_SETUP_KIND_FIELDS.includes(field)) out[field] = draft[field];
  return out as AiSetupAnswers;
}

/** The later of two screens. */
export const laterAiSetupStep = (a: AiSetupStep | null, b: AiSetupStep): AiSetupStep =>
  a && AI_SETUP_STEPS.indexOf(a) > AI_SETUP_STEPS.indexOf(b) ? a : b;

/** Who did it, and when. */
export const AiSetupMark = z.object({ at: z.iso.datetime(), by: z.uuid() });
export type AiSetupMark = z.infer<typeof AiSetupMark>;

/** What the business keeps. */
export interface AiSetupRecord {
  /** The answers so far while someone is part way through; null once finished, or before anyone started. */
  readonly draft: AiSetupAnswers | null;
  /** The furthest screen finished in the draft. */
  readonly reached: AiSetupStep | null;
  /** The kind of business the draft was answered for. */
  readonly kind: SetupKind | null;
  readonly started: AiSetupMark | null;
  /** The last time it was finished. */
  readonly finished: AiSetupMark | null;
  /** How many times it has been finished. */
  readonly runs: number;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const parsed = <T>(schema: z.ZodType<T>, v: unknown): T | null => {
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
};

/** What a business keeps of quick setup, from its settings. */
export function aiSetupOf(settings: Record<string, unknown> | null | undefined): AiSetupRecord {
  const raw = asRecord(settings?.[AI_SETUP_SETTINGS_KEY]);
  const draft = raw['draft'] == null ? null : parsed(AiSetupAnswers, raw['draft']);
  const reached = draft ? parsed(z.enum(AI_SETUP_STEPS), raw['reached']) : null;
  const runs = raw['runs'];
  return {
    draft: reached ? draft : null,
    reached,
    kind: reached ? parsed(z.enum(SETUP_KINDS), raw['kind']) : null,
    started: parsed(AiSetupMark, raw['started']),
    finished: parsed(AiSetupMark, raw['finished']),
    runs: typeof runs === 'number' && Number.isInteger(runs) && runs > 0 ? runs : 0,
  };
}

/** What's stored, with nothing empty kept. */
export function storedAiSetup(next: AiSetupRecord): Record<string, unknown> {
  return {
    ...(next.draft && next.reached
      ? { draft: next.draft, reached: next.reached, ...(next.kind ? { kind: next.kind } : {}) }
      : {}),
    ...(next.started ? { started: next.started } : {}),
    ...(next.finished ? { finished: next.finished } : {}),
    ...(next.runs ? { runs: next.runs } : {}),
  };
}
