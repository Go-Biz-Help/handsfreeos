/**
 * The form definition (`FormDefinition`, version 1): one tree that the question list, the live preview and
 * the Assistant all edit, only through the patch ops in ops.ts. A mode (form, survey or quiz), `pages[]`
 * of questions with stable ids, the calculations, the results they can land on, what happens when they
 * submit, and the settings.
 *
 * A form, a survey and a quiz are the same shape. `mode` changes what the editor puts in front of the
 * business and how a response reads afterwards, not what a question is — which is why a survey can be
 * turned into a quiz without rebuilding it.
 *
 * Browser-safe, so the editor checks a form with the same schema the server saves it with.
 */
import { z } from 'zod';
import { AssignTo, NotifyWho } from '../workflows/actions';
import { Ref } from '../workflows/ids';
import { CalculationId, PageId, QuestionId, ResultId } from './ids';
import {
  AnswerConditionGroup,
  Calculation,
  MAX_CALCULATIONS,
  Scoring,
  calculationProblems,
} from './logic';
import {
  AnswerTarget,
  CHOICE_TYPES,
  QUESTION_CONFIGS,
  UNANSWERED_TYPES,
  targetAccepts,
  type QuestionType,
} from './questions';

export const FORM_DEFINITION_VERSION = 1;

export const FORM_MODES = ['form', 'survey', 'quiz'] as const;
export type FormMode = (typeof FORM_MODES)[number];

export const FORM_MODE_LABELS: Readonly<Record<FormMode, string>> = {
  form: 'Form',
  survey: 'Survey',
  quiz: 'Quiz',
};

export const MAX_PAGES = 30;
export const MAX_QUESTIONS_PER_PAGE = 60;
export const MAX_QUESTIONS = 200;
export const MAX_RESULTS = 20;

// ---- Questions ----

const questionBase = {
  id: QuestionId,
  /** What the customer reads. */
  title: z.string().trim().min(1, 'Write the question.').max(300),
  /** The smaller line under it. */
  help: z.string().trim().max(500).default(''),
  required: z.boolean().default(false),
  /** Shown only when the answers so far pass this. An empty group always shows it. */
  showIf: AnswerConditionGroup.prefault({}),
  /** Where the answer is written on the customer's record; null keeps it on the response only. */
  mapTo: AnswerTarget.nullable().default(null),
};

const question = <T extends QuestionType>(type: T) =>
  z.object({ ...questionBase, type: z.literal(type), config: QUESTION_CONFIGS[type] });

export const Question = z.discriminatedUnion('type', [
  question('short_text'),
  question('long_text'),
  question('choice'),
  question('checkboxes'),
  question('yes_no'),
  question('number'),
  question('money'),
  question('date'),
  question('time'),
  question('rating'),
  question('scale'),
  question('email'),
  question('phone'),
  question('address'),
  question('file'),
  question('signature'),
  question('content'),
  question('payment'),
]);
export type Question = z.infer<typeof Question>;
export type QuestionInput = z.input<typeof Question>;

// ---- Pages ----

/**
 * A page of questions. A short form is one page; a long one breaks into several, and a page can be skipped
 * whole with its own rule. "One question at a time" (the settings) shows them one by one regardless.
 */
export const FormPage = z.object({
  id: PageId,
  /** Shown above the questions; blank is fine on a one-page form. */
  title: z.string().trim().max(160).default(''),
  showIf: AnswerConditionGroup.prefault({}),
  questions: z
    .array(Question)
    .max(MAX_QUESTIONS_PER_PAGE)
    .default(() => []),
});
export type FormPage = z.infer<typeof FormPage>;
export type FormPageInput = z.input<typeof FormPage>;

// ---- Where they land ----

/**
 * What they see when they're done. Every form has at least one — the thank-you screen. A quiz or a
 * recommendation form has several, and the first one whose rule passes wins; otherwise the choices' votes
 * decide; otherwise the last result is the fallback.
 */
export const FormResult = z.object({
  id: ResultId,
  /** What the business calls it in the editor. */
  name: z.string().trim().min(1, 'Name it.').max(80),
  headline: z.string().trim().min(1, 'Write the headline.').max(200),
  body: z.string().trim().max(4000).default(''),
  showIf: AnswerConditionGroup.prefault({}),
  buttonLabel: z.string().trim().max(60).default(''),
  buttonUrl: z.url().max(500).nullable().default(null),
  /** Send them straight on instead of showing the screen. */
  redirectUrl: z.url().max(500).nullable().default(null),
});
export type FormResult = z.infer<typeof FormResult>;
export type FormResultInput = z.input<typeof FormResult>;

// ---- What happens when they submit ----

export const PersonOnSubmit = z.object({
  /** How an answer is matched to somebody already in the book. */
  match: z.enum(['phone', 'email', 'phone_or_email']).default('phone_or_email'),
  /** Add them when nobody matches. Off means the response waits for someone to deal with it. */
  create: z.boolean().default(true),
  /** Written on a customer this form adds: "Website form", "Trade show". */
  source: z.string().trim().max(120).default(''),
  tagIds: z
    .array(Ref)
    .max(20)
    .default(() => []),
});

export const LeadOnSubmit = z.object({
  pipelineId: Ref,
  stageId: Ref,
  /** A template, so it can carry the answers: "Quote for {{answer.q_abc12345}}". */
  title: z.string().trim().min(1, 'Name the lead.').max(160),
  /** A calculation's answer as the lead's value (an instant quote). */
  valueFrom: CalculationId.nullable().default(null),
  assignTo: AssignTo.default({ kind: 'nobody' }),
});

export const TaskOnSubmit = z.object({
  title: z.string().trim().min(1, 'Name the task.').max(160),
  assignTo: AssignTo.default({ kind: 'nobody' }),
  dueInDays: z.int().min(0).max(365).default(0),
});

export const OnSubmit = z.object({
  person: PersonOnSubmit.prefault({}),
  lead: LeadOnSubmit.nullable().default(null),
  task: TaskOnSubmit.nullable().default(null),
  /** Workflows started for the customer, in order. */
  workflowIds: z
    .array(Ref)
    .max(5)
    .default(() => []),
  /** Who hears about it as it comes in; null tells nobody (the morning email still counts it). */
  notify: NotifyWho.nullable().default(null),
});
export type OnSubmit = z.infer<typeof OnSubmit>;
export type OnSubmitInput = z.input<typeof OnSubmit>;

// ---- Settings ----

export const FormSettings = z.object({
  /**
   * Whether they have to say who they are. `required` needs a name and a way to reach them, `optional`
   * asks but takes an answer without it, and `anonymous` records no customer at all — an honest survey.
   */
  identity: z.enum(['required', 'optional', 'anonymous']).default('required'),
  /** One question per screen, the way the AI teammate asks them. */
  oneQuestionAtATime: z.boolean().default(false),
  showProgress: z.boolean().default(true),
  /** Come back later and carry on (a link they can keep). Never on an anonymous form. */
  saveAndResume: z.boolean().default(true),
  /** Stop a customer answering twice. */
  oneResponsePerPerson: z.boolean().default(false),
  submitLabel: z.string().trim().min(1).max(40).default('Submit'),
  /** Stop taking answers after this moment, or this many of them. */
  closesAt: z.iso.datetime().nullable().default(null),
  closesAfter: z.int().min(1).max(1_000_000).nullable().default(null),
  /** What a visitor reads once it's closed. */
  closedMessage: z.string().trim().max(500).default('This form is closed.'),
});
export type FormSettings = z.infer<typeof FormSettings>;
export type FormSettingsInput = z.input<typeof FormSettings>;

// ---- The definition ----

export const FormDefinition = z.object({
  version: z.literal(FORM_DEFINITION_VERSION).default(FORM_DEFINITION_VERSION),
  mode: z.enum(FORM_MODES).default('form'),
  title: z.string().trim().min(1, 'Name the form.').max(160),
  /** Shown above the first question. */
  intro: z.string().trim().max(4000).default(''),
  pages: z.array(FormPage).min(1, 'A form needs a page.').max(MAX_PAGES),
  calculations: z
    .array(Calculation)
    .max(MAX_CALCULATIONS)
    .default(() => []),
  results: z.array(FormResult).min(1, 'A form needs somewhere to land.').max(MAX_RESULTS),
  scoring: Scoring.prefault({}),
  onSubmit: OnSubmit.prefault({}),
  settings: FormSettings.prefault({}),
});
export type FormDefinition = z.infer<typeof FormDefinition>;
export type FormDefinitionInput = z.input<typeof FormDefinition>;

// ---- Reading the tree ----

/** Every question, in the order they are asked. */
export function allQuestions(definition: Pick<FormDefinition, 'pages'>): Question[] {
  return definition.pages.flatMap((page) => page.questions);
}

/** One question and the page it sits on. */
export function findQuestion(
  definition: Pick<FormDefinition, 'pages'>,
  questionId: string,
): { question: Question; page: FormPage; index: number } | null {
  for (const page of definition.pages) {
    const index = page.questions.findIndex((q) => q.id === questionId);
    if (index >= 0) return { question: page.questions[index]!, page, index };
  }
  return null;
}

export function findPage(
  definition: Pick<FormDefinition, 'pages'>,
  pageId: string,
): FormPage | null {
  return definition.pages.find((p) => p.id === pageId) ?? null;
}

/** Every choice's `value`, by choice id, for the calculations. */
export function choiceValues(definition: Pick<FormDefinition, 'pages'>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const question of allQuestions(definition)) {
    if (!CHOICE_TYPES.has(question.type)) continue;
    const config = question.config as { choices?: { id: string; value: number | null }[] };
    for (const choice of config.choices ?? [])
      if (choice.value !== null) out[choice.id] = choice.value;
  }
  return out;
}

/** The questions a quiz scores. */
export function gradedQuestions(definition: Pick<FormDefinition, 'pages'>): Question[] {
  return allQuestions(definition).filter((q) => {
    if (q.type === 'yes_no') return (q.config as { correct: string | null }).correct !== null;
    if (CHOICE_TYPES.has(q.type))
      return ((q.config as { choices: { correct: boolean }[] }).choices ?? []).some(
        (c) => c.correct,
      );
    return false;
  });
}

// ---- Checks the schema alone can't make ----

/**
 * What's wrong with a form beyond its shape: repeated ids, a rule that reads a question asked later, an
 * outcome that doesn't exist, calculations that go round in a circle, a quiz with nothing to score. The
 * editor shows these as it goes and `form.publish` refuses while any are left.
 */
export function formProblems(definition: FormDefinition): string[] {
  const problems: string[] = [];
  const questions = allQuestions(definition);

  const pageIds = definition.pages.map((p) => p.id);
  if (new Set(pageIds).size !== pageIds.length) problems.push('Two pages share an id.');
  const questionIds = questions.map((q) => q.id);
  if (new Set(questionIds).size !== questionIds.length) problems.push('Two questions share an id.');
  const resultIds = definition.results.map((r) => r.id);
  if (new Set(resultIds).size !== resultIds.length) problems.push('Two results share an id.');
  const calcIds = definition.calculations.map((c) => c.id);
  if (new Set(calcIds).size !== calcIds.length) problems.push('Two calculations share an id.');
  if (questions.length > MAX_QUESTIONS)
    problems.push(`A form holds up to ${MAX_QUESTIONS} questions.`);

  const known = new Set(questionIds);
  const knownCalcs = new Set(calcIds);
  const knownResults = new Set(resultIds);

  // A rule may only read what has already been asked: the position of each question, page by page.
  const position = new Map<string, number>();
  questions.forEach((q, i) => position.set(q.id, i));

  const checkGroup = (group: AnswerConditionGroup, where: string, askedBy: number): void => {
    const walk = (g: { conditions: readonly unknown[] }): void => {
      for (const item of g.conditions) {
        if (item && typeof item === 'object' && 'conditions' in item) {
          walk(item as { conditions: readonly unknown[] });
          continue;
        }
        const condition = item as { source: { kind: string; questionId?: string; calculationId?: string } };
        const source = condition.source;
        if (source.kind === 'question') {
          const id = source.questionId!;
          if (!known.has(id)) {
            problems.push(`${where} reads a question that isn’t there.`);
            continue;
          }
          if ((position.get(id) ?? 0) >= askedBy)
            problems.push(`${where} reads an answer that hasn’t been given yet.`);
        }
        if (source.kind === 'calculation' && !knownCalcs.has(source.calculationId!))
          problems.push(`${where} reads a calculation that isn’t there.`);
      }
    };
    walk(group);
  };

  definition.pages.forEach((page) => {
    const first = page.questions.length ? (position.get(page.questions[0]!.id) ?? 0) : questions.length;
    checkGroup(page.showIf, `The rule on “${page.title || 'a page'}”`, first);
    page.questions.forEach((q) => {
      checkGroup(q.showIf, `The rule on “${q.title}”`, position.get(q.id) ?? 0);
      if (q.required && UNANSWERED_TYPES.has(q.type))
        problems.push(`“${q.title}” asks nothing, so it can’t be required.`);
      if (q.mapTo && !targetAccepts(q.mapTo, q.type))
        problems.push(`“${q.title}” can’t fill in that field.`);
    });
  });

  // Results are worked out once everything has been answered, so they may read anything.
  definition.results.forEach((r) => checkGroup(r.showIf, `The rule on “${r.name}”`, questions.length));

  for (const question of questions) {
    if (question.type !== 'payment') continue;
    const { amount } = question.config as {
      amount: { kind: string; calculationId?: string; questionId?: string };
    };
    if (amount.kind === 'calculation' && !knownCalcs.has(amount.calculationId!))
      problems.push(`“${question.title}” charges a calculation that isn’t there.`);
    if (amount.kind === 'question' && !known.has(amount.questionId!))
      problems.push(`“${question.title}” charges an answer that isn’t there.`);
  }

  for (const question of questions) {
    if (!CHOICE_TYPES.has(question.type)) continue;
    const config = question.config as { choices?: { resultId: string | null }[] };
    for (const choice of config.choices ?? [])
      if (choice.resultId && !knownResults.has(choice.resultId)) {
        problems.push(`“${question.title}” points at a result that isn’t there.`);
        break;
      }
  }

  for (const term of definition.calculations.flatMap((c) => c.terms))
    for (const factor of term.factors) {
      if (factor.kind === 'question' && !known.has(factor.questionId))
        problems.push('A calculation uses a question that isn’t there.');
      if (factor.kind === 'calculation' && !knownCalcs.has(factor.calculationId))
        problems.push('A calculation uses another that isn’t there.');
    }
  problems.push(...calculationProblems(definition.calculations));

  return [...new Set(problems.filter(Boolean))];
}

/** Whether a quiz can actually be scored. */
export function scoringProblems(definition: FormDefinition): string[] {
  if (!definition.scoring.enabled) return [];
  return gradedQuestions(definition).length
    ? []
    : ['Nothing is marked as a right answer, so there is nothing to score.'];
}
