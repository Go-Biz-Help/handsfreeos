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
  AnswerTargetRef,
  CHOICE_TYPES,
  QUESTION_CONFIGS,
  UNANSWERED_TYPES,
  targetAccepts,
  type QuestionType,
} from './questions';
import { videoLinkProblem } from './video';

export const FORM_DEFINITION_VERSION = 1;

/**
 * `poll` is a live poll (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2): its questions and buttons pop up one at
 * a time in a HandsFreeOS video call, and each person's answers are one response on their contact. It's never filled
 * in on a page, in a conversation or on the phone.
 */
export const FORM_MODES = ['form', 'survey', 'quiz', 'poll'] as const;
export type FormMode = (typeof FORM_MODES)[number];

export const FORM_MODE_LABELS: Readonly<Record<FormMode, string>> = {
  form: 'Form',
  survey: 'Survey',
  quiz: 'Quiz',
  poll: 'Live poll',
};

export const MAX_PAGES = 30;
export const MAX_QUESTIONS_PER_PAGE = 60;
export const MAX_QUESTIONS = 200;
export const MAX_RESULTS = 20;

// ---- Live polls ----

/** What a live poll asks: pick one, pick any, yes or no, a rating, a 1 to 10 scale, a short answer, and buttons. */
export const POLL_QUESTION_TYPES: ReadonlySet<QuestionType> = new Set([
  'choice',
  'checkboxes',
  'yes_no',
  'rating',
  'scale',
  'short_text',
  'button',
]);
/** Types that only make sense popping up in a call. */
export const POLL_ONLY_TYPES: ReadonlySet<QuestionType> = new Set(['button']);
export const MAX_POLL_ITEMS = 30;
/** How long a question stays up unless it says otherwise (the owner's 15). */
export const POLL_SECONDS = 60;
export const POLL_MIN_SECONDS = 10;
export const POLL_MAX_SECONDS = 600;
/** When-to-ask phrases a live poll's question holds, at most, and the longest one. */
export const POLL_MAX_CUES = 8;
export const POLL_CUE_CHARS = 160;
/** The most pages a live poll's slides may have. */
export const MAX_SLIDES = 100;
/** The biggest PDF of slides: the attachments bucket's limit. */
export const SLIDES_MAX_BYTES = 25 * 1024 * 1024;

/**
 * A live poll's slides (part 4): the presentation as a PDF, uploaded for the poll (`form.begin_slides_upload`), its
 * file's record the form. The team shows them slide by slide in the call, and the AI reads them to tie each question
 * to its slide. Left out, the poll has none.
 */
export const PollSlides = z.object({
  fileId: z.uuid(),
  /** The PDF's name, as it was uploaded. */
  name: z.string().trim().min(1).max(200),
  pages: z.int().min(1).max(MAX_SLIDES),
});
export type PollSlides = z.infer<typeof PollSlides>;

/**
 * How a question runs in a live poll: how long it stays up, and whether everyone sees the totals once it closes (the
 * owner's 16). Left out, the defaults: a minute, and the totals kept for the team. A short answer's totals are never
 * shown to everyone: they're what people typed.
 */
export const LiveQuestion = z.object({
  seconds: z.int().min(POLL_MIN_SECONDS).max(POLL_MAX_SECONDS).default(POLL_SECONDS),
  showResults: z.boolean().default(false),
  /**
   * What the presenter might say just before asking it (part 3): the AI hearing the call matches the team's words to
   * these by meaning, beside the question itself. Written by the AI or the business; none, and it goes by the question.
   */
  cues: z.array(z.string().trim().min(1).max(POLL_CUE_CHARS)).max(POLL_MAX_CUES).default([]),
  /**
   * The slide it goes with, counted from 1 (part 4): the AI reads the poll's slides and picks it, or the business
   * does. The AI hearing the call expects the question around that slide, and the team is offered it when the slide
   * comes up. None, and it goes by the words alone.
   */
  slide: z.int().min(1).max(MAX_SLIDES).nullish(),
});
export type LiveQuestion = z.infer<typeof LiveQuestion>;

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
  /**
   * Where the answer is written: a field of the customer or the lead, or `custom:<id>` for one the business
   * invented. Null keeps it on the response, where it still shows on the customer's timeline.
   */
  mapTo: AnswerTargetRef.nullable().default(null),
  /** In a live poll: how long it stays up and who sees the totals. Left out, `LiveQuestion`'s defaults. */
  live: LiveQuestion.nullish(),
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
  question('video'),
  question('booking'),
  question('button'),
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
  /**
   * Save their details when they leave this page, not only when they send the whole form (funnels): the customer
   * is matched or made, the fields this page filled are written and the lead opens here, so a funnel that loses
   * them on the next video still has who they were. One page a form, and it has to ask how to reach them.
   */
  savesContact: z.boolean().default(false),
  questions: z
    .array(Question)
    .max(MAX_QUESTIONS_PER_PAGE)
    .default(() => []),
});
export type FormPage = z.infer<typeof FormPage>;
export type FormPageInput = z.input<typeof FormPage>;

// ---- Where they land ----

/**
 * A web page a result links or sends them on to: http or https only. `z.url()` alone takes any scheme
 * `new URL()` parses, `javascript:` included, and the public form navigates to this on the app's origin.
 */
const WebAddress = z
  .url({ protocol: /^https?$/, error: 'Give a web address starting https://.' })
  .max(500);

/**
 * Where a result's button may go: a web page, or a call or an email to the business. Never a redirect — those
 * stay web pages — but a "Call us" button on a thank-you screen is an ordinary thing to have.
 */
const ButtonAddress = z
  .url({
    protocol: /^(https?|tel|mailto)$/,
    error: 'Give a web address starting https://, or a tel: or mailto: link.',
  })
  .max(500);

const schemeOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
};

/** Whether a stored link is one a result may still send them on to: http or https. */
export function isWebAddress(value: unknown): value is string {
  const scheme = schemeOf(value);
  return scheme === 'https:' || scheme === 'http:';
}

/** Whether a stored link is one a result's button may still use: a web page, a call or an email. */
export function isButtonAddress(value: unknown): value is string {
  const scheme = schemeOf(value);
  return isWebAddress(value) || scheme === 'tel:' || scheme === 'mailto:';
}

/**
 * A stored definition with any result link it may no longer use dropped, so a form saved before
 * `WebAddress` was strict still reads (and can no longer send anyone to a `javascript:` address).
 */
export function withSafeResultLinks(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { results?: unknown }).results))
    return raw;
  const results = (raw as { results: unknown[] }).results.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const out = { ...(r as Record<string, unknown>) };
    if (out['buttonUrl'] != null && !isButtonAddress(out['buttonUrl'])) out['buttonUrl'] = null;
    if (out['redirectUrl'] != null && !isWebAddress(out['redirectUrl'])) out['redirectUrl'] = null;
    return out;
  });
  return { ...(raw as object), results };
}

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
  buttonUrl: ButtonAddress.nullable().default(null),
  /** Send them straight on instead of showing the screen. */
  redirectUrl: WebAddress.nullable().default(null),
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
  /**
   * One page per screen, with Back and Next, instead of every page down one long screen: a funnel that walks
   * somebody through a video, their details, a longer video and a few questions, one step at a time.
   */
  onePageAtATime: z.boolean().default(false),
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
  /** A live poll's slides (part 4); left out, it has none. */
  slides: PollSlides.nullish(),
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

/** How a question runs in a live poll, its defaults filled in. */
export function liveOf(question: Pick<Question, 'live'>): LiveQuestion {
  return LiveQuestion.parse(question.live ?? {});
}

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
        const condition = item as {
          source: { kind: string; questionId?: string; calculationId?: string };
        };
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
    const first = page.questions.length
      ? (position.get(page.questions[0]!.id) ?? 0)
      : questions.length;
    checkGroup(page.showIf, `The rule on “${page.title || 'a page'}”`, first);
    page.questions.forEach((q) => {
      checkGroup(q.showIf, `The rule on “${q.title}”`, position.get(q.id) ?? 0);
      if (q.required && UNANSWERED_TYPES.has(q.type))
        problems.push(`“${q.title}” asks nothing, so it can’t be required.`);
      if (q.mapTo && !targetAccepts(q.mapTo, q.type))
        problems.push(`“${q.title}” can’t fill in that field.`);
    });
  });

  const saving = definition.pages.filter((p) => p.savesContact);
  if (saving.length > 1) problems.push('Only one page can save their details.');
  for (const page of saving) {
    const reaches = page.questions.some(
      (q) =>
        q.type === 'email' ||
        q.type === 'phone' ||
        q.mapTo === 'person.email' ||
        q.mapTo === 'person.phone',
    );
    if (!reaches)
      problems.push(
        `“${page.title || 'The page that saves their details'}” needs a phone or an email question, so there’s someone to save.`,
      );
    if (definition.settings.identity === 'anonymous')
      problems.push('An anonymous form doesn’t keep anyone’s details, so no page can save them.');
  }

  // Results are worked out once everything has been answered, so they may read anything.
  definition.results.forEach((r) =>
    checkGroup(r.showIf, `The rule on “${r.name}”`, questions.length),
  );

  for (const question of questions) {
    if (question.type !== 'video') continue;
    const problem = videoLinkProblem(
      question.title,
      question.config as { url: string; minPercent: number | null },
    );
    if (problem) problems.push(problem);
  }

  const bookings = questions.filter((q) => q.type === 'booking');
  if (bookings.length > 1)
    problems.push('A form can book one time. Keep one “Book a time” question.');
  for (const question of bookings) {
    if (!(question.config as { calendarId: string }).calendarId)
      problems.push(`“${question.title}” needs a calendar to book on.`);
    if (definition.settings.identity === 'anonymous')
      problems.push(
        `“${question.title}” books a time, and an anonymous form keeps nobody to book it for.`,
      );
  }

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

  if (definition.mode === 'poll') problems.push(...pollProblems(definition));
  else if (definition.slides)
    problems.push('Only a live poll has slides. Take them off, or make this a Live poll.');
  if (definition.mode !== 'poll')
    for (const question of questions)
      if (POLL_ONLY_TYPES.has(question.type))
        problems.push(
          `“${question.title}” is a button for a live poll. Make this form a Live poll, or take the button out.`,
        );

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

/**
 * What's wrong with a live poll: a question that can't pop up in a call, a rule (a question pops up when it's asked,
 * so nothing decides whether it shows), too many to get through, and a button with nowhere to go.
 */
function pollProblems(definition: FormDefinition): string[] {
  const problems: string[] = [];
  const questions = allQuestions(definition);
  if (!questions.length) problems.push('A live poll needs a question or a button.');
  if (questions.length > MAX_POLL_ITEMS)
    problems.push(`A live poll holds up to ${MAX_POLL_ITEMS} questions and buttons.`);
  if (
    definition.pages.some((p) => p.showIf.conditions.length) ||
    questions.some((q) => q.showIf.conditions.length)
  )
    problems.push(
      'Questions in a live poll pop up when they’re asked, so they can’t have rules. Take the rules off.',
    );
  for (const question of questions) {
    if (!POLL_QUESTION_TYPES.has(question.type)) {
      problems.push(
        `“${question.title}” can’t pop up in a live poll. Use pick one, pick any, yes or no, a rating, a scale, a short answer or a button.`,
      );
      continue;
    }
    const slide = question.live?.slide;
    if (slide && slide > (definition.slides?.pages ?? 0))
      problems.push(
        definition.slides
          ? `“${question.title}” goes with slide ${slide}, but the slides have ${definition.slides.pages}. Pick another slide, or none.`
          : `“${question.title}” goes with slide ${slide}, but this poll has no slides. Add them, or pick no slide.`,
      );
    if (question.type !== 'button') continue;
    const button = question.config as { action: string; url: string; calendarId: string };
    if (button.action === 'link' && !isWebAddress(button.url))
      problems.push(`“${question.title}” needs a web address starting https:// to open.`);
    if (button.action === 'book' && !button.calendarId)
      problems.push(`“${question.title}” needs a calendar to book on.`);
  }
  return problems;
}

/** Whether a quiz can actually be scored. */
export function scoringProblems(definition: FormDefinition): string[] {
  if (!definition.scoring.enabled) return [];
  return gradedQuestions(definition).length
    ? []
    : ['Nothing is marked as a right answer, so there is nothing to score.'];
}
