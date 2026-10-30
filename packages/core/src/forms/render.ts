/**
 * Filling a form in: which questions are showing right now, whether an answer will do, what the numbers
 * come to, and where the person lands at the end.
 *
 * One engine, three places: the public page runs it as they type, the AI teammate runs it to know what to
 * ask next in a conversation, and the server runs it again when the response arrives — so a form that hid
 * a question can't be submitted with an answer to it, however the answers were posted.
 *
 * Browser-safe.
 */
import { normalizePhone } from '../crm/phone';
import { isClock, isLocalDate } from '../calendar/engine/zoned';
import {
  allQuestions,
  choiceValues,
  type FormDefinition,
  type FormPage,
  type FormResult,
  type Question,
} from './definition';
import {
  evaluateAnswers,
  runCalculations,
  resultVotes,
  scoreAnswers,
  type AnswerSheet,
  type LogicFacts,
  type ScoreResult,
} from './logic';
import type { FillContext } from './personal';
import { answerIsEmpty, CHOICE_TYPES, UNANSWERED_TYPES, type AnswerValue } from './questions';
import { isBookingAnswer } from './booking';
import { watchFirstWords } from './video';

/** A page with only the questions that are showing. */
export interface VisiblePage {
  readonly page: FormPage;
  readonly questions: readonly Question[];
}

export interface FormState {
  /** The answers with anything given to a hidden question taken out. */
  readonly answers: AnswerSheet;
  readonly calculations: Readonly<Record<string, number>>;
  readonly score: ScoreResult;
  readonly pages: readonly VisiblePage[];
  /** Every showing question, in the order they are asked. */
  readonly questions: readonly Question[];
  /** How much of it is done, 0 to 1, counting only questions that are showing and ask something. */
  readonly progress: number;
}

const asked = (question: Question): boolean => !UNANSWERED_TYPES.has(question.type);

function factsFor(definition: FormDefinition, answers: AnswerSheet): LogicFacts {
  const calculations = runCalculations(definition.calculations, answers, choiceValues(definition));
  const score = scoreAnswers(allQuestions(definition), answers, definition.scoring);
  return { answers, calculations, score: { points: score.points, percent: score.percent } };
}

/**
 * The pages and questions showing for these answers. A question that fills a contact detail we already have is
 * skipped (`fill.known`, a personal link), and a page left with nothing on it isn't shown at all, so a funnel's
 * name page disappears for somebody we know.
 */
function showing(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): VisiblePage[] {
  const facts = factsFor(definition, answers);
  const known = fill.known;
  return definition.pages
    .filter((page) => evaluateAnswers(page.showIf, facts))
    .map((page) => ({
      page,
      questions: page.questions.filter(
        (question) =>
          !(known && question.mapTo && known.has(question.mapTo)) &&
          evaluateAnswers(question.showIf, facts),
      ),
    }))
    .filter((visible) => visible.questions.length > 0 || visible.page.questions.length === 0);
}

/**
 * The answers to questions that are showing. Change "Do you have a dog?" from yes to no and the answer to
 * "What breed?" goes with it — hiding a question and keeping its answer is how a form ends up recording
 * something nobody was asked. Taking one answer away can hide another, so it settles.
 */
export function prunedAnswers(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): AnswerSheet {
  let current: AnswerSheet = { ...answers };
  for (let pass = 0; pass < 10; pass++) {
    const visible = new Set(
      showing(definition, current, fill)
        .flatMap((p) => p.questions)
        .map((q) => q.id),
    );
    const kept = Object.fromEntries(
      Object.entries(current).filter(([questionId]) => visible.has(questionId)),
    );
    if (Object.keys(kept).length === Object.keys(current).length) return kept;
    current = kept;
  }
  return current;
}

/** Everything a screen needs: what is showing, what the numbers come to, and how far along they are. */
export function formState(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): FormState {
  const kept = prunedAnswers(definition, answers, fill);
  const facts = factsFor(definition, kept);
  const pages = showing(definition, kept, fill);
  const questions = pages.flatMap((p) => p.questions);
  const answerable = questions.filter(asked);
  const done = answerable.filter((q) => !answerIsEmpty(kept[q.id] ?? null));
  return {
    answers: kept,
    calculations: facts.calculations ?? {},
    score: scoreAnswers(allQuestions(definition), kept, definition.scoring),
    pages,
    questions,
    progress: answerable.length ? done.length / answerable.length : 1,
  };
}

/**
 * The next question to ask, for the AI teammate and for one-question-at-a-time: the first one showing that
 * hasn't been answered. null means there is nothing left to ask.
 */
export function nextQuestion(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): Question | null {
  const state = formState(definition, answers, fill);
  return (
    state.questions.find((q) => asked(q) && answerIsEmpty(state.answers[q.id] ?? null)) ?? null
  );
}

// ---- Is this answer any good? ----

export interface AnswerProblem {
  readonly questionId: string;
  readonly message: string;
}

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

const choiceIds = (question: Question): string[] =>
  ((question.config as { choices?: { id: string }[] }).choices ?? []).map((c) => c.id);

const decimalsOf = (value: number): number => (String(value).split('.')[1] ?? '').length;

/**
 * What's wrong with one answer, or null when it will do. `required` is checked by the caller against what
 * is showing, since a hidden question is never required.
 */
export function answerProblem(question: Question, value: AnswerValue): string | null {
  if (!asked(question)) return null;
  // A video is answered by watching it, so not having started is 0%, and the gate is what holds them back.
  if (question.type === 'video') return videoProblem(question, value);
  if (answerIsEmpty(value)) return question.required ? 'Answer this one.' : null;
  const config = question.config as Record<string, unknown>;

  switch (question.type) {
    case 'short_text':
    case 'long_text': {
      if (typeof value !== 'string') return 'Write an answer.';
      const max = Number(config.maxLength);
      return value.length > max ? `Keep it under ${max} characters.` : null;
    }
    case 'email':
      return typeof value === 'string' && isEmail(value) ? null : 'Enter an email address.';
    case 'phone':
      return typeof value === 'string' && normalizePhone(value) ? null : 'Enter a phone number.';
    case 'choice': {
      if (typeof value !== 'string') return 'Pick one.';
      if (choiceIds(question).includes(value)) return null;
      return config.allowOther ? null : 'Pick one of the choices.';
    }
    case 'checkboxes': {
      if (!Array.isArray(value)) return 'Pick what applies.';
      const known = new Set(choiceIds(question));
      if (!config.allowOther && !value.every((v) => known.has(String(v))))
        return 'Pick from the choices.';
      const min = config.min as number | null;
      const max = config.max as number | null;
      if (min !== null && value.length < min) return `Pick at least ${min}.`;
      if (max !== null && value.length > max) return `Pick no more than ${max}.`;
      return null;
    }
    case 'yes_no':
      return typeof value === 'boolean' || value === 'yes' || value === 'no' ? null : 'Yes or no.';
    case 'number':
    case 'money': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return 'Enter a number.';
      const min = config.min as number | null;
      const max = config.max as number | null;
      if (min !== null && n < min) return `Enter ${min} or more.`;
      if (max !== null && n > max) return `Enter ${max} or less.`;
      if (question.type === 'money' && decimalsOf(n) > 2) return 'Cents only, please.';
      if (question.type === 'number' && decimalsOf(n) > Number(config.decimals))
        return Number(config.decimals) === 0
          ? 'Whole numbers only.'
          : `Up to ${config.decimals} decimal places.`;
      return null;
    }
    case 'date': {
      if (typeof value !== 'string' || !isLocalDate(value)) return 'Pick a date.';
      const today = new Date().toISOString().slice(0, 10);
      if (config.range === 'past' && value > today) return 'Pick a date that has been.';
      if (config.range === 'future' && value < today) return 'Pick a date to come.';
      return null;
    }
    case 'time':
      return typeof value === 'string' && isClock(value) ? null : 'Pick a time.';
    case 'rating':
    case 'scale': {
      const n = Number(value);
      const min = question.type === 'rating' ? 1 : Number(config.min);
      const max = Number(config.max);
      return Number.isInteger(n) && n >= min && n <= max ? null : `Pick from ${min} to ${max}.`;
    }
    case 'address': {
      const address = value as { line1?: string; city?: string; postalCode?: string };
      if (typeof address !== 'object') return 'Enter an address.';
      if (config.detail === 'full' && !address.line1?.trim()) return 'Enter the street.';
      if (!address.city?.trim() && !address.postalCode?.trim())
        return 'Enter a town or a postcode.';
      return null;
    }
    case 'file': {
      if (!Array.isArray(value)) return 'Attach a file.';
      const files = value as { bytes?: number }[];
      if (files.length > Number(config.maxFiles)) return `Up to ${config.maxFiles} files.`;
      const limit = Number(config.maxMb) * 1024 * 1024;
      return files.some((f) => Number(f.bytes) > limit)
        ? `Each file under ${config.maxMb}MB.`
        : null;
    }
    case 'signature': {
      const signature = value as { name?: string };
      return typeof signature === 'object' && signature.name?.trim()
        ? null
        : 'Type your name to sign.';
    }
    case 'payment':
      // The money itself is taken at submit; nothing to check here.
      return null;
    case 'booking':
      // Whether the time is still free is the calendar's to say, when the form is sent.
      return isBookingAnswer(value) ? null : 'Pick one of the times.';
    case 'button':
      // A live poll's button: pressing it is the answer.
      return value === true ? null : 'Press the button.';
    default:
      return null;
  }
}

function videoProblem(question: Question, value: AnswerValue): string | null {
  const watched = answerIsEmpty(value) ? 0 : value;
  if (typeof watched !== 'number' || !Number.isInteger(watched) || watched < 0 || watched > 100)
    return 'Watch the video here.';
  const { minPercent } = question.config as { minPercent: number | null };
  if (minPercent !== null && watched < minPercent) return watchFirstWords(minPercent);
  return question.required && watched === 0 ? 'Play the video to go on.' : null;
}

/**
 * Everything wrong with a response: unanswered required questions and answers that don't fit, over the
 * questions that are actually showing. An answer to a hidden question is dropped, not complained about.
 */
export function responseProblems(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): AnswerProblem[] {
  const state = formState(definition, answers, fill);
  const problems: AnswerProblem[] = [];
  for (const question of state.questions) {
    const problem = answerProblem(question, state.answers[question.id] ?? null);
    if (problem) problems.push({ questionId: question.id, message: problem });
  }
  return problems;
}

/** Whether the questions showing on this page are all answered well enough to move on. */
export function pageProblems(
  definition: FormDefinition,
  answers: AnswerSheet,
  pageId: string,
  fill: FillContext = {},
): AnswerProblem[] {
  const state = formState(definition, answers, fill);
  const page = state.pages.find((p) => p.page.id === pageId);
  if (!page) return [];
  const ids = new Set(page.questions.map((q) => q.id));
  return responseProblems(definition, answers, fill).filter((p) => ids.has(p.questionId));
}

/**
 * Where somebody picks up on a form shown one page at a time: the first showing page with something still to
 * do (a required question, a video not watched enough) or that they haven't touched yet, else the last one.
 * A sheet picked up again lands where they left off rather than at the start.
 */
export function pageToResume(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): string | null {
  const state = formState(definition, answers, fill);
  const problems = new Set(responseProblems(definition, answers, fill).map((p) => p.questionId));
  const page = state.pages.find(
    (p) =>
      p.questions.some((q) => problems.has(q.id)) ||
      (p.questions.some(asked) &&
        !p.questions.some((q) => asked(q) && !answerIsEmpty(state.answers[q.id] ?? null))),
  );
  return (page ?? state.pages[state.pages.length - 1])?.page.id ?? null;
}

// ---- Where they land ----

/**
 * The result they see. A rule that passes wins, first one down; otherwise the outcome their choices voted
 * for most (earliest wins a tie); otherwise the last result, which is the thank-you screen.
 */
export function pickResult(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): FormResult {
  const state = formState(definition, answers, fill);
  const facts: LogicFacts = {
    answers: state.answers,
    calculations: state.calculations,
    score: { points: state.score.points, percent: state.score.percent },
  };
  const ruled = definition.results.find(
    (result) => result.showIf.conditions.length > 0 && evaluateAnswers(result.showIf, facts),
  );
  if (ruled) return ruled;

  const votes = resultVotes(allQuestions(definition), state.answers);
  let winner: FormResult | null = null;
  let best = 0;
  for (const result of definition.results) {
    const count = votes[result.id] ?? 0;
    if (count > best) {
      best = count;
      winner = result;
    }
  }
  return winner ?? definition.results[definition.results.length - 1]!;
}

/** The answers ready to be recorded, with the question's wording copied in so they still read right later. */
export interface RecordedAnswer {
  readonly questionId: string;
  /** What the question said at the moment they answered it. */
  readonly title: string;
  readonly type: Question['type'];
  readonly value: AnswerValue;
  /** For a pick-one or pick-any, what the choices they picked were called. */
  readonly labels: readonly string[];
}

export function recordAnswers(
  definition: FormDefinition,
  answers: AnswerSheet,
  fill: FillContext = {},
): RecordedAnswer[] {
  const state = formState(definition, answers, fill);
  return state.questions.filter(asked).map((question) => {
    const value = state.answers[question.id] ?? null;
    const labels: string[] = [];
    if (CHOICE_TYPES.has(question.type)) {
      const choices =
        (question.config as { choices?: { id: string; label: string }[] }).choices ?? [];
      const picked = Array.isArray(value)
        ? value.map(String)
        : value === null
          ? []
          : [String(value)];
      for (const id of picked) labels.push(choices.find((c) => c.id === id)?.label ?? String(id));
    }
    return { questionId: question.id, title: question.title, type: question.type, value, labels };
  });
}
