/**
 * Live polls in HandsFreeOS video calls (HANDSFREEOS_WEBINARS_IMPLEMENTATION_PLAN.md, part 2): what a question looks
 * like on everyone's screen, the message that carries it, the totals, and when one closes early. Browser-safe, so the
 * worker, the team's panel and the attendee's pop-up all read them the same way.
 *
 * - **A live poll** is a form of mode `poll` (forms/definition.ts), picked on the call (`video_calls.poll_form_id`).
 * - **Asking a question** opens it for its seconds (the owner's 15). The worker tells the room on its own data topic;
 *   every page shows it, and the team's panel shows the answers coming in.
 * - **It closes** when its time is up, once nearly everyone watching has answered, or when the team closes it. Its
 *   totals go to everyone only when the question says so (16); the team always sees them.
 */
import { z } from 'zod';
import { liveOf, type Question } from '../forms/definition';
import type { AnswerValue } from '../forms/questions';

/** The data topic polls travel on, from the worker to everyone in the call. */
export const VIDEO_CALL_POLLS_TOPIC = 'hfos.polls';

export const POLL_STATES = ['open', 'closed', 'skipped'] as const;
export type PollState = (typeof POLL_STATES)[number];
/** Who put a question up: someone on the team, or the AI hearing the presenter (part 3). */
export const POLL_OPENERS = ['team', 'ai'] as const;
export type PollOpener = (typeof POLL_OPENERS)[number];

/** "Nearly everyone" (the owner's 15): a question closes early once this share of the people watching answered. */
export const POLL_NEARLY_ALL = 0.9;
/** An answer that set off just before the question closed still counts. */
export const POLL_GRACE_MS = 3_000;
/** How often the team's panel reads the answers while a question is up. */
export const POLL_PANEL_POLL_MS = 2_000;
/** The typed answers the team's panel shows for a short answer, newest first. */
export const POLL_TEXTS_SHOWN = 30;
/** The names the team's panel shows for a button, newest first. */
export const POLL_PRESSED_SHOWN = 50;

/** Whether a question has heard from nearly everyone watching. Nobody watching never closes it early. */
export function closesEarly(answered: number, watching: number): boolean {
  return watching > 0 && answered >= Math.ceil(watching * POLL_NEARLY_ALL);
}

// ---- What a question looks like on screen ----

const Choice = z.object({ id: z.string().max(40), label: z.string().max(160) });

/** A live poll's question or button, as every page in the call shows it. */
export const PollOnScreen = z.object({
  pollId: z.uuid(),
  questionId: z.string().max(40),
  type: z.enum(['choice', 'checkboxes', 'yes_no', 'rating', 'scale', 'short_text', 'button']),
  title: z.string().max(300),
  help: z.string().max(500).default(''),
  /** Pick one and pick any; yes or no as `yes` and `no`. */
  choices: z.array(Choice).max(60).default([]),
  /** A rating or a scale: the numbers to pick from, and the words at either end. */
  min: z.int().default(1),
  max: z.int().default(10),
  minLabel: z.string().max(40).default(''),
  maxLabel: z.string().max(40).default(''),
  /** A short answer's longest. */
  maxLength: z.int().default(120),
  /** A button: its words, what it does, and where it goes (a link, or the booking page). */
  button: z
    .object({
      label: z.string().max(40),
      action: z.enum(['link', 'book', 'talk']),
      url: z.string().max(500).nullable(),
    })
    .nullable()
    .default(null),
  closesAt: z.iso.datetime(),
});
export type PollOnScreen = z.infer<typeof PollOnScreen>;
export type PollType = PollOnScreen['type'];

/** A question from the published poll, as the room sees it. `buttonUrl` is where a book button goes. */
export function pollOnScreen(
  question: Question,
  at: { readonly pollId: string; readonly closesAt: string; readonly buttonUrl?: string | null },
): PollOnScreen {
  const config = question.config as Record<string, unknown>;
  const base = {
    pollId: at.pollId,
    questionId: question.id,
    type: question.type as PollType,
    title: question.title,
    help: question.help,
    closesAt: at.closesAt,
  };
  switch (question.type) {
    case 'choice':
    case 'checkboxes':
      return PollOnScreen.parse({
        ...base,
        choices: (config.choices as { id: string; label: string }[]).map((c) => ({
          id: c.id,
          label: c.label,
        })),
      });
    case 'yes_no':
      return PollOnScreen.parse({
        ...base,
        choices: [
          { id: 'yes', label: String(config.yesLabel) },
          { id: 'no', label: String(config.noLabel) },
        ],
      });
    case 'rating':
      return PollOnScreen.parse({ ...base, min: 1, max: Number(config.max) });
    case 'scale':
      return PollOnScreen.parse({
        ...base,
        min: Number(config.min),
        max: Number(config.max),
        minLabel: String(config.minLabel ?? ''),
        maxLabel: String(config.maxLabel ?? ''),
      });
    case 'short_text':
      return PollOnScreen.parse({ ...base, maxLength: Number(config.maxLength) });
    case 'button': {
      const action = config.action as 'link' | 'book' | 'talk';
      return PollOnScreen.parse({
        ...base,
        button: {
          label: String(config.label),
          action,
          url:
            action === 'link'
              ? String(config.url)
              : action === 'book'
                ? (at.buttonUrl ?? null)
                : null,
        },
      });
    }
    default:
      return PollOnScreen.parse(base);
  }
}

// ---- The totals ----

export const PollTotals = z.object({
  /** How many answered (or pressed a button). */
  answered: z.int().min(0),
  /** A bar per choice, per yes and no, or per number on a rating or a scale. */
  bars: z.array(z.object({ id: z.string().max(40), label: z.string().max(160), count: z.int() })),
  /** A rating or a scale: the average, to one decimal. */
  average: z.number().nullable(),
});
export type PollTotals = z.infer<typeof PollTotals>;

/**
 * Everyone's answers to one question, counted: how many answered, how many picked each choice (yes and no included),
 * and how many gave each number. What the database counts for a call (`pollCounts`) and what `countAnswers` makes.
 */
export interface PollCounts {
  readonly answered: number;
  readonly byChoice: Readonly<Record<string, number>>;
  readonly byNumber: Readonly<Record<string, number>>;
}

/** Counts from the answers themselves. */
export function countAnswers(answers: readonly AnswerValue[]): PollCounts {
  const byChoice: Record<string, number> = {};
  const byNumber: Record<string, number> = {};
  let answered = 0;
  for (const a of answers) {
    if (a === null || a === '') continue;
    answered++;
    const picked = Array.isArray(a)
      ? a.map(String)
      : typeof a === 'boolean'
        ? [a ? 'yes' : 'no']
        : typeof a === 'string'
          ? [a]
          : [];
    for (const id of picked) byChoice[id] = (byChoice[id] ?? 0) + 1;
    if (typeof a === 'number') byNumber[String(a)] = (byNumber[String(a)] ?? 0) + 1;
  }
  return { answered, byChoice, byNumber };
}

/** The totals for a question from its counts. A short answer and a button count only. */
export function pollTotals(question: Question, counts: PollCounts): PollTotals {
  const shown = pollOnScreen(question, {
    pollId: '00000000-0000-4000-8000-000000000000',
    closesAt: new Date(0).toISOString(),
  });
  if (question.type === 'choice' || question.type === 'checkboxes' || question.type === 'yes_no')
    return {
      answered: counts.answered,
      bars: shown.choices.map((c) => ({
        id: c.id,
        label: c.label,
        // Yes and no are kept as true and false, which the database counts as 1 and 0.
        count:
          counts.byChoice[c.id] ??
          (question.type === 'yes_no' ? (counts.byNumber[c.id === 'yes' ? '1' : '0'] ?? 0) : 0),
      })),
      average: null,
    };
  if (question.type === 'rating' || question.type === 'scale') {
    const bars = [];
    let sum = 0;
    let n = 0;
    for (let v = shown.min; v <= shown.max; v++) {
      const count = counts.byNumber[String(v)] ?? 0;
      bars.push({ id: String(v), label: String(v), count });
      sum += v * count;
      n += count;
    }
    return {
      answered: counts.answered,
      bars,
      average: n ? Math.round((sum / n) * 10) / 10 : null,
    };
  }
  return { answered: counts.answered, bars: [], average: null };
}

/** Whether everyone may see a question's totals once it closes: when it says so, and never what people typed. */
export function totalsShown(question: Question): boolean {
  return (
    liveOf(question).showResults && question.type !== 'short_text' && question.type !== 'button'
  );
}

// ---- The message ----

/** What the worker tells the room: a question is up, or it closed (with its totals when everyone sees them). */
export const PollMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('open'), poll: PollOnScreen }),
  z.object({ t: z.literal('close'), pollId: z.uuid(), totals: PollTotals.nullable() }),
]);
export type PollMessage = z.infer<typeof PollMessage>;

/** A message on the polls topic, or null for anything that isn't one. */
export function readPollMessage(payload: Uint8Array | string): PollMessage | null {
  try {
    const text = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    const parsed = PollMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Seconds left on a question, never below nothing. */
export function pollSecondsLeft(closesAt: string, now: number): number {
  return Math.max(0, Math.ceil((new Date(closesAt).getTime() - now) / 1000));
}

// ---- The words ----

export const POLL_WORDS = {
  /** The team's panel. */
  panel: 'Live poll',
  pick: 'Pick a live poll',
  pickHelp: 'Make one in Forms as a Live poll, publish it, and its questions can pop up here.',
  none: 'No live poll',
  upNext: 'Up next',
  askNow: 'Ask now',
  skip: 'Skip',
  close: 'Close',
  skipped: 'Skipped',
  asked: 'Asked',
  allAsked: 'Every question has been asked.',
  unpublished: (name: string) => `Publish “${name}” in Forms, and its questions can pop up here.`,
  answered: (n: number, watching: number) =>
    watching > 0 ? `${n} of ${watching} answered` : n === 1 ? '1 answer' : `${n} answers`,
  pressed: (n: number) => (n === 1 ? '1 pressed it' : `${n} pressed it`),
  byAi: 'Asked by the AI',
  everyoneSees: 'Everyone sees the totals when it closes',
  teamSees: 'Only your team sees the totals',
  /** The pop-up. */
  send: 'Send',
  thanks: 'Thanks. Your answer is in.',
  closed: 'This question has closed.',
  results: 'Results',
  secondsLeft: (s: number) => (s === 1 ? '1 second left' : `${s} seconds left`),
  saved: (business: string) => `Your answers are saved by ${business}.`,
  talkSent: 'Thanks. Someone will be in touch.',
  /** The forms editor. */
  seconds: 'Seconds it stays up',
  showResults: 'Show everyone the totals when it closes',
  buttonAction: {
    talk: 'Tell us they’d like to talk',
    link: 'Open a web page',
    book: 'Open the booking page',
  },
} as const;
