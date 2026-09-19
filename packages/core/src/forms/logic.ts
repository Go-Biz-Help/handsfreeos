/**
 * What a form works out while someone fills it in: which questions to show, what the numbers add up to,
 * and how a quiz scored. Three pieces, all reading the same answers so far:
 *
 * - conditions (`AnswerConditionGroup`) — show or hide a question, and pick which result they land on;
 * - calculations — sums of products over answers ("square feet × $3.50, plus the trip fee"), so a form can
 *   quote a price on the spot;
 * - scoring — points, the percentage, and whether they passed.
 *
 * Browser-safe: the page in front of the customer and the server that saves the response run this same code,
 * so what they were shown is what gets recorded.
 */
import { z } from 'zod';
import { CalculationId, QuestionId } from './ids';
import { answerIsEmpty, type AnswerValue, type QuestionType } from './questions';

// ---- What a rule can read ----

/** An answer, a calculation's answer, or how the quiz is scoring. */
export const LogicSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), questionId: QuestionId }),
  z.object({ kind: z.literal('calculation'), calculationId: CalculationId }),
  z.object({ kind: z.literal('score') }),
  z.object({ kind: z.literal('percent') }),
]);
export type LogicSource = z.infer<typeof LogicSource>;

export const ANSWER_OPERATORS = [
  'is',
  'is_not',
  'is_one_of',
  'is_none_of',
  'includes',
  'excludes',
  'contains',
  'not_contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'answered',
  'not_answered',
] as const;
export type AnswerOperator = (typeof ANSWER_OPERATORS)[number];

export const ANSWER_OPERATOR_LABELS: Readonly<Record<AnswerOperator, string>> = {
  is: 'is',
  is_not: 'is not',
  is_one_of: 'is one of',
  is_none_of: 'is none of',
  includes: 'includes',
  excludes: 'doesn’t include',
  contains: 'contains',
  not_contains: 'doesn’t contain',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  between: 'is between',
  answered: 'is answered',
  not_answered: 'is not answered',
};

/** Operators that need no value of their own. */
export const NO_VALUE_OPERATORS: ReadonlySet<AnswerOperator> = new Set(['answered', 'not_answered']);

/** Operators that only make sense on a number. */
export const NUMERIC_OPERATORS: ReadonlySet<AnswerOperator> = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
]);

export const AnswerCondition = z
  .object({
    source: LogicSource,
    op: z.enum(ANSWER_OPERATORS),
    value: z.unknown().default(null),
  })
  .superRefine((c, ctx) => {
    if (NO_VALUE_OPERATORS.has(c.op)) return;
    if (c.op === 'between') {
      const ok =
        Array.isArray(c.value) && c.value.length === 2 && c.value.every((v) => Number.isFinite(v));
      if (!ok)
        ctx.addIssue({ code: 'custom', message: 'Give a low and a high number.', path: ['value'] });
      return;
    }
    if (c.op === 'is_one_of' || c.op === 'is_none_of') {
      if (!Array.isArray(c.value) || c.value.length === 0)
        ctx.addIssue({ code: 'custom', message: 'Pick at least one.', path: ['value'] });
      return;
    }
    if (c.value === null || c.value === undefined || c.value === '')
      ctx.addIssue({ code: 'custom', message: 'Give something to compare with.', path: ['value'] });
    if (NUMERIC_OPERATORS.has(c.op) && !Number.isFinite(Number(c.value)))
      ctx.addIssue({ code: 'custom', message: 'Compare with a number.', path: ['value'] });
  });
export type AnswerCondition = z.infer<typeof AnswerCondition>;
export type AnswerConditionInput = z.input<typeof AnswerCondition>;

const Match = z.enum(['all', 'any']);
const MAX_CONDITIONS = 20;
const Inner = z.object({
  match: Match.default('all'),
  conditions: z.array(AnswerCondition).max(MAX_CONDITIONS),
});

/** A group of checks: all of them, or any one of them. Groups nest one level, which covers what people build. */
export const AnswerConditionGroup = z.object({
  match: Match.default('all'),
  conditions: z
    .array(z.union([AnswerCondition, Inner]))
    .max(MAX_CONDITIONS)
    .default(() => []),
});
export type AnswerConditionGroup = z.infer<typeof AnswerConditionGroup>;
export type AnswerConditionGroupInput = z.input<typeof AnswerConditionGroup>;

/** Any group at any depth, for code that walks them. */
export interface AnyAnswerGroup {
  readonly match: 'all' | 'any';
  readonly conditions: readonly (AnswerCondition | AnyAnswerGroup)[];
}

export function emptyAnswerGroup(): AnswerConditionGroup {
  return { match: 'all', conditions: [] };
}

export function isAnswerGroup(x: AnswerCondition | AnyAnswerGroup): x is AnyAnswerGroup {
  return 'conditions' in x;
}

/** Every condition in a group, depth first. */
export function allAnswerConditions(group: AnyAnswerGroup): AnswerCondition[] {
  return group.conditions.flatMap((c) => (isAnswerGroup(c) ? allAnswerConditions(c) : [c]));
}

/** The questions a group reads, so the editor can warn when one is asked later than it is used. */
export function answerConditionQuestionIds(group: AnyAnswerGroup): string[] {
  return [
    ...new Set(
      allAnswerConditions(group)
        .map((c) => (c.source.kind === 'question' ? c.source.questionId : null))
        .filter((id): id is string => id !== null),
    ),
  ];
}

// ---- Reading an answer ----

/** The answers given so far, by question id. */
export type AnswerSheet = Readonly<Record<string, AnswerValue>>;

export interface LogicFacts {
  readonly answers: AnswerSheet;
  /** Worked out by `runCalculations`. */
  readonly calculations?: Readonly<Record<string, number>>;
  readonly score?: { readonly points: number; readonly percent: number };
}

const text = (v: unknown): string =>
  typeof v === 'string' ? v.toLowerCase().trim() : String(v ?? '').toLowerCase();

/** "Yes" and true are the same answer, however the page sent it. */
const yesNo = (v: unknown): string | null =>
  typeof v === 'boolean' ? (v ? 'yes' : 'no') : v === 'yes' || v === 'no' ? v : null;

const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  const [ya, yb] = [yesNo(a), yesNo(b)];
  if (ya !== null && yb !== null) return ya === yb;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return text(a) === text(b);
};

/**
 * An answer as a number: a number is itself, a list is how many were picked, yes is 1 and no is 0, and
 * text is the number in it when there is one.
 */
export function numericAnswer(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[$,\s]/g, ''));
    return Number.isFinite(n) && value.trim() !== '' ? n : null;
  }
  return null;
}

function readSource(source: LogicSource, facts: LogicFacts): unknown {
  switch (source.kind) {
    case 'question':
      return facts.answers[source.questionId] ?? null;
    case 'calculation':
      return facts.calculations?.[source.calculationId] ?? null;
    case 'score':
      return facts.score?.points ?? null;
    case 'percent':
      return facts.score?.percent ?? null;
  }
}

function check(condition: AnswerCondition, raw: unknown): boolean {
  const { op, value } = condition;
  const empty = answerIsEmpty(raw);
  switch (op) {
    case 'answered':
      return !empty;
    case 'not_answered':
      return empty;
    case 'is':
      return !empty && (Array.isArray(raw) ? raw.length === 1 && same(raw[0], value) : same(raw, value));
    case 'is_not':
      return !(
        !empty && (Array.isArray(raw) ? raw.length === 1 && same(raw[0], value) : same(raw, value))
      );
    case 'is_one_of':
      return (
        !empty && Array.isArray(value) && value.some((v) => (Array.isArray(raw) ? raw.some((r) => same(r, v)) : same(raw, v)))
      );
    case 'is_none_of':
      return !(
        !empty &&
        Array.isArray(value) &&
        value.some((v) => (Array.isArray(raw) ? raw.some((r) => same(r, v)) : same(raw, v)))
      );
    case 'includes':
      return Array.isArray(raw) ? raw.some((r) => same(r, value)) : same(raw, value);
    case 'excludes':
      return !(Array.isArray(raw) ? raw.some((r) => same(r, value)) : same(raw, value));
    case 'contains':
      return !empty && text(raw).includes(text(value));
    case 'not_contains':
      return !(!empty && text(raw).includes(text(value)));
    case 'between': {
      const n = numericAnswer(raw);
      if (n === null || !Array.isArray(value)) return false;
      const [low, high] = [Number(value[0]), Number(value[1])];
      return n >= Math.min(low, high) && n <= Math.max(low, high);
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = numericAnswer(raw);
      const v = Number(value);
      if (n === null || !Number.isFinite(v)) return false;
      return op === 'gt' ? n > v : op === 'gte' ? n >= v : op === 'lt' ? n < v : n <= v;
    }
  }
}

/** Whether the answers so far pass the group. An empty group passes, so a question with no rule is shown. */
export function evaluateAnswers(group: AnyAnswerGroup, facts: LogicFacts): boolean {
  const run = (g: AnyAnswerGroup): boolean => {
    if (!g.conditions.length) return true;
    const test = (c: AnswerCondition | AnyAnswerGroup) =>
      isAnswerGroup(c) ? run(c) : check(c, readSource(c.source, facts));
    return g.match === 'all' ? g.conditions.every(test) : g.conditions.some(test);
  };
  return run(group);
}

// ---- Calculations ----

/** One thing multiplied into a term: a plain number, an answer, or another calculation's answer. */
export const CalculationFactor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), value: z.number().min(-1e9).max(1e9) }),
  z.object({ kind: z.literal('question'), questionId: QuestionId }),
  z.object({ kind: z.literal('calculation'), calculationId: CalculationId }),
]);
export type CalculationFactor = z.infer<typeof CalculationFactor>;

/** Its factors multiplied together. One factor on its own is just that number. */
export const CalculationTerm = z.object({
  factors: z.array(CalculationFactor).min(1, 'Add something to multiply.').max(4),
});
export type CalculationTerm = z.infer<typeof CalculationTerm>;

export const MAX_CALCULATIONS = 20;

/**
 * A number worked out from the answers: the terms are multiplied out and added up. "1200 sq ft × $3.50
 * plus a $75 trip fee" is two terms. `format` is only how it reads on the page.
 */
export const Calculation = z.object({
  id: CalculationId,
  name: z.string().trim().min(1, 'Name it.').max(80),
  terms: z.array(CalculationTerm).min(1, 'Add a term.').max(20),
  round: z.enum(['none', 'up', 'down', 'nearest']).default('none'),
  min: z.number().min(-1e9).max(1e9).nullable().default(null),
  max: z.number().min(-1e9).max(1e9).nullable().default(null),
  format: z.enum(['number', 'money', 'percent']).default('number'),
  decimals: z.int().min(0).max(2).default(0),
});
export type Calculation = z.infer<typeof Calculation>;
export type CalculationInput = z.input<typeof Calculation>;

/**
 * The numeric worth of an answer for arithmetic: a picked choice counts as its `value` (a price), and a
 * pick-any question as its picked choices' values added up. Falls back to the plain number in the answer.
 */
export function answerNumber(
  questionId: string,
  answers: AnswerSheet,
  choiceValues?: Readonly<Record<string, number>>,
): number {
  const raw = answers[questionId] ?? null;
  if (raw === null) return 0;
  if (choiceValues) {
    if (typeof raw === 'string' && raw in choiceValues) return choiceValues[raw]!;
    if (Array.isArray(raw)) {
      const picked = raw.filter((id): id is string => typeof id === 'string' && id in choiceValues);
      if (picked.length) return picked.reduce((sum, id) => sum + (choiceValues[id] ?? 0), 0);
    }
  }
  return numericAnswer(raw) ?? 0;
}

function applyLimits(value: number, calc: Calculation): number {
  let out = value;
  if (calc.round === 'up') out = Math.ceil(out);
  else if (calc.round === 'down') out = Math.floor(out);
  else if (calc.round === 'nearest') out = Math.round(out);
  if (calc.min !== null) out = Math.max(calc.min, out);
  if (calc.max !== null) out = Math.min(calc.max, out);
  return Number.isFinite(out) ? out : 0;
}

/**
 * Every calculation's answer, by id. One calculation may use another; a loop between them counts as 0
 * rather than hanging (the editor refuses to save one — see `calculationProblems`).
 */
export function runCalculations(
  calculations: readonly Calculation[],
  answers: AnswerSheet,
  choiceValues: Readonly<Record<string, number>> = {},
): Record<string, number> {
  const byId = new Map(calculations.map((c) => [c.id, c]));
  const done: Record<string, number> = {};
  const busy = new Set<string>();

  const value = (id: string): number => {
    if (id in done) return done[id]!;
    const calc = byId.get(id);
    if (!calc || busy.has(id)) return 0;
    busy.add(id);
    const total = calc.terms.reduce((sum, term) => {
      const product = term.factors.reduce((acc, factor) => {
        if (factor.kind === 'number') return acc * factor.value;
        if (factor.kind === 'question')
          return acc * answerNumber(factor.questionId, answers, choiceValues);
        return acc * value(factor.calculationId);
      }, 1);
      return sum + product;
    }, 0);
    busy.delete(id);
    done[id] = applyLimits(total, calc);
    return done[id]!;
  };

  for (const calc of calculations) value(calc.id);
  return done;
}

/** Calculations that use each other in a circle, which the editor won't save. */
export function calculationProblems(calculations: readonly Calculation[]): string[] {
  const byId = new Map(calculations.map((c) => [c.id, c]));
  const problems: string[] = [];
  const state = new Map<string, 'busy' | 'done'>();

  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'busy') {
      const names = [...trail, id].map((x) => byId.get(x)?.name ?? x);
      problems.push(`${names.join(' → ')} go round in a circle.`);
      return;
    }
    state.set(id, 'busy');
    for (const term of byId.get(id)?.terms ?? [])
      for (const factor of term.factors)
        if (factor.kind === 'calculation') walk(factor.calculationId, [...trail, id]);
    state.set(id, 'done');
  };

  for (const calc of calculations) walk(calc.id, []);
  return [...new Set(problems)];
}

// ---- Scoring ----

export const Scoring = z.object({
  /** Add the points up and grade it. Off for a plain form or survey. */
  enabled: z.boolean().default(false),
  /** The mark they need to pass, as a percentage; null means there is no pass or fail. */
  passPercent: z.int().min(0).max(100).nullable().default(null),
  showScore: z.boolean().default(true),
  /** When they get to see which ones they got right. */
  showAnswers: z.enum(['never', 'after', 'on_pass']).default('never'),
});
export type Scoring = z.infer<typeof Scoring>;
export type ScoringInput = z.input<typeof Scoring>;

/** The shape scoring needs from a question, so this stays clear of the definition. */
export interface ScorableQuestion {
  readonly id: string;
  readonly type: QuestionType;
  readonly config: unknown;
}

interface ScorableChoice {
  readonly id: string;
  readonly correct: boolean;
  readonly points: number;
}

function choicesOf(question: ScorableQuestion): ScorableChoice[] {
  const config = question.config as { choices?: ScorableChoice[] } | null;
  return Array.isArray(config?.choices) ? config.choices : [];
}

export interface QuestionScore {
  readonly questionId: string;
  readonly points: number;
  readonly possible: number;
  /** null when the question isn't graded — a survey question sitting in a quiz. */
  readonly correct: boolean | null;
}

export interface ScoreResult {
  readonly points: number;
  readonly possible: number;
  /** Points as a percentage of what was on offer; 0 when nothing was. */
  readonly percent: number;
  readonly correct: number;
  readonly graded: number;
  /** null when no pass mark is set. */
  readonly passed: boolean | null;
  readonly byQuestion: readonly QuestionScore[];
}

function scoreOne(question: ScorableQuestion, answer: AnswerValue): QuestionScore {
  const base = { questionId: question.id };
  if (question.type === 'choice') {
    const choices = choicesOf(question);
    const graded = choices.some((c) => c.correct);
    const picked = choices.find((c) => c.id === answer) ?? null;
    return {
      ...base,
      points: picked?.points ?? 0,
      possible: Math.max(0, ...choices.map((c) => c.points), 0),
      correct: graded ? (picked?.correct ?? false) : null,
    };
  }
  if (question.type === 'checkboxes') {
    const choices = choicesOf(question);
    const graded = choices.some((c) => c.correct);
    const picked = new Set(Array.isArray(answer) ? answer.map(String) : []);
    const wanted = choices.filter((c) => c.correct).map((c) => c.id);
    const exact = wanted.length === picked.size && wanted.every((id) => picked.has(id));
    return {
      ...base,
      points: choices.filter((c) => picked.has(c.id)).reduce((sum, c) => sum + c.points, 0),
      possible: choices.reduce((sum, c) => sum + Math.max(0, c.points), 0),
      correct: graded ? exact : null,
    };
  }
  if (question.type === 'yes_no') {
    const config = question.config as { correct?: 'yes' | 'no' | null; points?: number } | null;
    const want = config?.correct ?? null;
    const points = config?.points ?? 0;
    if (want === null) return { ...base, points: 0, possible: 0, correct: null };
    const said = answer === true || answer === 'yes' ? 'yes' : answer === false || answer === 'no' ? 'no' : null;
    const right = said === want;
    return { ...base, points: right ? points : 0, possible: Math.max(0, points), correct: right };
  }
  return { ...base, points: 0, possible: 0, correct: null };
}

/** What a quiz came to: the points, the percentage, how many were right, and whether they passed. */
export function scoreAnswers(
  questions: readonly ScorableQuestion[],
  answers: AnswerSheet,
  scoring: Pick<Scoring, 'passPercent'> = { passPercent: null },
): ScoreResult {
  const byQuestion = questions.map((q) => scoreOne(q, answers[q.id] ?? null));
  const points = byQuestion.reduce((sum, s) => sum + s.points, 0);
  const possible = byQuestion.reduce((sum, s) => sum + s.possible, 0);
  const graded = byQuestion.filter((s) => s.correct !== null);
  const percent = possible > 0 ? Math.round((points / possible) * 100) : 0;
  return {
    points,
    possible,
    percent,
    correct: graded.filter((s) => s.correct).length,
    graded: graded.length,
    passed: scoring.passPercent === null ? null : percent >= scoring.passPercent,
    byQuestion,
  };
}

/** Which result a set of choices votes for, and how many votes each got. */
export function resultVotes(
  questions: readonly ScorableQuestion[],
  answers: AnswerSheet,
): Record<string, number> {
  const votes: Record<string, number> = {};
  for (const question of questions) {
    const config = question.config as { choices?: { id: string; resultId?: string | null }[] } | null;
    if (!Array.isArray(config?.choices)) continue;
    const answer = answers[question.id] ?? null;
    const picked = new Set(
      Array.isArray(answer) ? answer.map(String) : typeof answer === 'string' ? [answer] : [],
    );
    for (const choice of config.choices) {
      if (!choice.resultId || !picked.has(choice.id)) continue;
      votes[choice.resultId] = (votes[choice.resultId] ?? 0) + 1;
    }
  }
  return votes;
}
