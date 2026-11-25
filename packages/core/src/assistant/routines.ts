/**
 * What a person asks the Assistant to do on its own (the owner, 25 Nov 2026: "ok id like all of them", reminders and
 * scheduled asks first). Browser-safe: the web and the phone list them with these words, and the worker and the
 * Assistant's cards say them the same way.
 *
 * - **A question on a schedule** ("Every Monday at 8:00 AM: who owes me money?"): the worker asks it as the person,
 *   with look-ups only, answers in the routine's own chat, and sends the answer to their phone (and email, if they
 *   said so). When it runs is a workflow schedule's cadence, in the business's time zone.
 * - **An alert** ("Tell me when Dana Smith writes"): when it happens, a push to them alone, if they can still see it.
 *   Told once and then paused, or every time.
 * - **A reminder** ("Remind me at 3 PM to call Bob") is a task with a time, which pings whoever has it then
 *   (`task_due`): not a routine.
 *
 * Each is its person's alone, in one business, as their chats are (20261027036600).
 */
import { z } from 'zod';
import { formatClock } from '../messaging/quiet-hours';
import { money } from '../money/format';
import { uuid } from '../schemas/common';
import { Cadence } from '../workflows/definition';
import { nextOccurrence } from '../workflows/schedule';

/** How many one person may have in one business: a routine asks the AI, and each answer is paid for. */
export const MAX_ROUTINES = 25;
export const ROUTINE_QUESTION_MAX = 500;

/** When a question is asked: some days of the week, or a day of the month, at a time where the business is. */
export const RoutineCadence = Cadence;
export type RoutineCadence = z.infer<typeof RoutineCadence>;

export const ROUTINE_WATCHES = ['reply', 'booking', 'review', 'payment'] as const;
export type RoutineWatchKind = (typeof ROUTINE_WATCHES)[number];

/** What an alert watches for. */
export const RoutineWatch = z.discriminatedUnion('on', [
  /** A customer writes: a text, email, chat or message, on any conversation of theirs. */
  z.object({ on: z.literal('reply'), personId: uuid }),
  /** A customer books, online or by the team. */
  z.object({ on: z.literal('booking'), personId: uuid }),
  /** A new review of this many stars or fewer (5: any new review). */
  z.object({ on: z.literal('review'), atMost: z.int().min(1).max(5) }),
  /** An invoice of at least this much is paid in full (0: any). */
  z.object({ on: z.literal('payment'), atLeastCents: z.int().min(0).max(1_000_000_000) }),
]);
export type RoutineWatch = z.infer<typeof RoutineWatch>;

/** The permission an alert needs beyond the Assistant, so it never tells someone what their screens don't show. */
export const WATCH_PERMISSION: Readonly<Record<RoutineWatchKind, string>> = {
  reply: 'inbox.use',
  booking: 'records.read',
  review: 'records.read',
  payment: 'money.read',
};

/** Whether an alert stops after telling them once, unless they say: someone writing back once, a payment each time. */
export const defaultOnce = (watch: RoutineWatch): boolean =>
  watch.on === 'reply' || watch.on === 'booking';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ordinal = (n: number) => {
  const tail =
    n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${tail}`;
};

const listWords = (items: readonly string[]) =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** "Every Monday at 8:00 AM", "Every weekday at 7:00 AM", "On the 1st of each month at 9:00 AM". */
export function cadenceWords(c: RoutineCadence): string {
  const at = formatClock(c.at);
  if (c.every === 'monthly')
    return c.day === 'last'
      ? `On the last day of each month at ${at}`
      : `On the ${ordinal(c.day)} of each month at ${at}`;
  const days = [...new Set(c.days)].sort((a, b) => a - b);
  if (days.length === 7) return `Every day at ${at}`;
  if (days.join() === '1,2,3,4,5') return `Every weekday at ${at}`;
  if (days.join() === '0,6') return `Every weekend day at ${at}`;
  return `Every ${listWords(days.map((d) => DAY_NAMES[d]!))} at ${at}`;
}

/** The next time a question is asked after `after`, in the business's time zone (epoch milliseconds). */
export const nextRoutineRun = (c: RoutineCadence, after: Date | number, timeZone: string): number =>
  nextOccurrence(c, after, timeZone);

/**
 * "When Dana Smith writes", "When a review of 2 stars or less comes in". `name` is the customer's, for the two that
 * watch one; null when they can't be seen anymore.
 */
export function watchWords(w: RoutineWatch, name: string | null): string {
  const who = name?.trim() || 'that customer';
  switch (w.on) {
    case 'reply':
      return `When ${who} writes`;
    case 'booking':
      return `When ${who} books`;
    case 'review':
      return w.atMost >= 5
        ? 'When a new review comes in'
        : w.atMost === 1
          ? 'When a 1-star review comes in'
          : `When a review of ${w.atMost} stars or less comes in`;
    case 'payment':
      return w.atLeastCents > 0
        ? `When an invoice of ${money(w.atLeastCents)} or more is paid`
        : 'When an invoice is paid';
  }
}

/** One routine as its person's lists show it (`assistant_routine.list`). */
export const AssistantRoutineOut = z.object({
  id: uuid,
  kind: z.enum(['question', 'alert']),
  /** "Every Monday at 8:00 AM", or "When Dana Smith writes". */
  when: z.string(),
  /** The question it asks; null for an alert. */
  question: z.string().nullable(),
  cadence: RoutineCadence.nullable(),
  watch: RoutineWatch.nullable(),
  /** Its answers are emailed to them too. */
  email: z.boolean(),
  /** An alert that stops after telling them once. */
  once: z.boolean(),
  paused: z.boolean(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastFiredAt: z.string().nullable(),
  firedCount: z.int(),
  /** The chat a question's answers go in, once it has answered. */
  threadId: uuid.nullable(),
});
export type AssistantRoutineOut = z.infer<typeof AssistantRoutineOut>;

/** The line under a routine on the lists: when it runs next, or that it's paused, or what it did last. */
export function routineStatusWords(
  r: Pick<AssistantRoutineOut, 'kind' | 'paused' | 'once' | 'nextRunAt' | 'firedCount'>,
  formatWhen: (iso: string) => string,
): string {
  if (r.kind === 'alert') {
    if (r.paused) return r.once && r.firedCount > 0 ? 'Told you once, then stopped' : 'Paused';
    return r.once ? 'Tells you once, then stops' : 'Tells you every time';
  }
  if (r.paused) return 'Paused';
  return r.nextRunAt ? `Next: ${formatWhen(r.nextRunAt)}` : 'Waiting to be scheduled';
}

/** The words a push and an email open with, for a question's answer: the start of the answer, on one line. */
export function answerPreview(text: string, max = 180): string {
  const line = text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
