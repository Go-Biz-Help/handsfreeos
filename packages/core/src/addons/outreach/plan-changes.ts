/**
 * Changes a person makes to today's plan on a network (docs/outreach.md, decision 195, step 3; the owner, 25 Nov
 * 2026: "we could have the assistant tell the extension to do things or have buttons in the app"): **Do now**, **Skip
 * today** and **Move to a time** on a row of the Plan, and **Put back**. Each is kept for the day
 * (`addon_outreach.plan_changes`, one a row), and the day's rules read them (./plan.ts `nextMove`):
 *
 * - **Skip today** leaves it out for the rest of the day. It's back on tomorrow's plan if it's still due.
 * - **Move to a time** leaves it out until then. Where HandsFreeOS decides the order it goes first from then on;
 *   where the runner plans its own go, it's back on the list in its own place (`changesLead` in ./plan.ts).
 * - **Do now** puts it first: it's the runner's next move, after what it's doing and what the person asked of it.
 *
 * A change takes hold at the runner's next go: nothing wakes the extension for one.
 *
 * Nothing here lets a step past a limit: a change only picks among what the day's rules would do anyway, and when.
 * A first day's lists are still saved before anything, a batch of checks still waits its turn between batches, and
 * outside the working hours only replies go.
 *
 * What can be changed where:
 *
 * - **A step for someone on the list** (a like, a request, a message to write or send) can be skipped or moved on
 *   every network: what's skipped or not yet due is left off the list the extension is given (`outreach.today`, for
 *   the extension alone), so a runner never sees it, whoever plans its go.
 * - **A once-a-day read, and Do now**, only where HandsFreeOS decides the order (./plan-next.ts `PLAN_DECIDES`): a
 *   runner that plans for itself wouldn't know.
 *
 * Browser-safe: the web, the phone and the extension read these.
 */
import { z } from 'zod';
import { clockWords } from './live';
import { PLATFORM_KEYS } from './networks';
import { itemKey, workKey, type PlanItem, type Work } from './plan-rules';

/** What a row of the Plan can be told, with each button's words. */
export const PLAN_CHANGE_WORDS = {
  now: 'Do now',
  skip: 'Skip today',
  at: 'Move to a time',
} as const;
export type PlanChangeKind = keyof typeof PLAN_CHANGE_WORDS;
export const PLAN_CHANGE_KINDS = ['now', 'skip', 'at'] as const satisfies readonly PlanChangeKind[];
/** What `outreach.plan.change` can be asked: one of those, or `back`, to put the row back as it was. */
export const PLAN_CHANGE_ASKS = [...PLAN_CHANGE_KINDS, 'back'] as const;
export type PlanChangeAsk = (typeof PLAN_CHANGE_ASKS)[number];

/** The most changes a person keeps on one network in a day. */
export const PLAN_CHANGES_MOST = 100;
/** The longest a row's words are kept, and the longest a row's name. */
export const PLAN_CHANGE_TITLE_MOST = 200;
export const PLAN_CHANGE_KEY_MOST = 320;

/** A change to one row of today's plan on a network: Do now, Skip today, Move to a time, or Put back. */
export const PlanChangeInput = z.object({
  workspaceId: z.uuid(),
  /** The network whose plan: Facebook's when left out. */
  platform: z.enum(PLATFORM_KEYS).default('facebook'),
  /** The row, by the name the plan gives it (`key`). */
  key: z.string().min(1).max(PLAN_CHANGE_KEY_MOST),
  /** `now` puts it first, `skip` leaves it out today, `at` moves it to a time, `back` puts it back as it was. */
  change: z.enum(PLAN_CHANGE_ASKS),
  /** For a move: the time today on the business's own clock, as 15:30. */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Give the time as 15:30.')
    .optional(),
});
export type PlanChangeInput = z.input<typeof PlanChangeInput>;

export const PlanChangeOutput = z.object({
  key: z.string(),
  change: z.enum(PLAN_CHANGE_ASKS),
  /** For a move: when it goes from. */
  at: z.iso.datetime().nullable(),
  /** What the row said. */
  title: z.string(),
  /** What happens now, in a line. */
  words: z.string(),
});
export type PlanChangeOutput = z.output<typeof PlanChangeOutput>;

/** The words around the buttons, the same on the web and the phone. */
export const PLAN_CHANGE_UI = {
  back: 'Put back',
  /** The heading over what was skipped or moved. */
  changed: 'Skipped or moved today',
  first: 'First',
  moved: 'Moved',
  skipped: 'Skipped today',
  movedTo: (at: string, timeZone: string) => `Moved to ${clockWords(at, timeZone)}`,
  /** The row's menu, named for a screen reader with what the row says: "Change: Send a friend request (Dana Reyes)". */
  menu: (title: string) => `Change: ${title}`,
  /** The box for Move to a time. */
  timeLabel: 'What time today?',
  timeHint: 'It waits until then.',
  /** With no time left to pick today (the phone's list of times is empty). */
  noTimes: 'There’s no time left today to move it to.',
  move: 'Move',
  cancel: 'Cancel',
  /** A press that worked, said in a line. */
  done: {
    now: 'It goes next.',
    skip: 'Skipped for today.',
    at: (at: string, timeZone: string) => `Moved to about ${clockWords(at, timeZone)}.`,
    back: 'Put back on today’s plan.',
  },
} as const;

/** A moment on the business's clock: its day there, and the minutes into it. */
function localAt(at: string | Date | number, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return {
    day: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

const asClock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The day's last minute: a move can't be to tomorrow. */
const LAST_MINUTE = 23 * 60 + 59;

/** The first time Move to a time offers, in minutes: the next half hour that's at least a quarter of an hour off. */
const moveStart = (minutes: number): number =>
  Math.min(LAST_MINUTE, Math.ceil((minutes + 15) / 30) * 30);

/**
 * The time the box for Move to a time starts at, as 15:30 on the business's clock: the next half hour that's at least
 * a quarter of an hour off, and never past the day's last minute.
 */
export function planMoveStart(now: string | Date | number, timeZone: string): string {
  return asClock(moveStart(localAt(now, timeZone).minutes));
}

/**
 * The times Move to a time offers to pick from (the phone's), each as 15:30 with its words ("3:30 PM"): every half
 * hour from the box's start till the day's plan ends (`until`, as the plan says it; the day's end with none).
 */
export function planMoveTimes(
  now: string | Date | number,
  timeZone: string,
  until: string | Date | number | null,
): { time: string; label: string }[] {
  const from = localAt(now, timeZone);
  const end = until === null ? null : localAt(until, timeZone);
  // The plan ends today, or at midnight or later: then every time left today can be picked.
  const last = end !== null && end.day === from.day ? end.minutes : LAST_MINUTE + 1;
  const times: { time: string; label: string }[] = [];
  for (let at = moveStart(from.minutes); at < last; at += 30) {
    const hour = Math.floor(at / 60);
    times.push({
      time: asClock(at),
      label: `${hour % 12 || 12}:${String(at % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`,
    });
  }
  return times;
}

/** A change kept for today. Times are on HandsFreeOS's clock, in milliseconds. */
export interface PlanChange {
  /** The row it's about: `jobChangeKey` or `workChangeKey`. */
  readonly key: string;
  readonly change: PlanChangeKind;
  /** For a move: the time it goes from. */
  readonly at: number | null;
  /** When it was made: what was put first earliest goes first. */
  readonly made: number;
}

/** A once-a-day read's row. */
export const jobChangeKey = (job: string): string => `job:${job}`;
/** A piece of the list's work's row. */
export const workChangeKey = (work: Work): string => `work:${workKey(work)}`;
/** The once-a-day read a key names, or null for any other row. */
export const jobOfChangeKey = (key: string): string | null =>
  key.startsWith('job:') ? key.slice(4) : null;

/**
 * The rows someone on today's list would be worked under as they stand: their step, and their message to write (with
 * none yet) or the one written for them. A message OK'd after its writing was skipped still goes: it's another row.
 */
export const itemChangeKeys = (
  item: Pick<PlanItem, 'kind' | 'postId' | 'profileId' | 'name' | 'retry' | 'send'>,
): string[] => [
  `work:${itemKey(item)}`,
  item.send === null ? `work:draft:${itemKey(item)}` : `work:send:${item.send.sendId}`,
];

/** How the day's changes stand at a moment. */
export interface ChangesNow {
  /** Left out now: skipped, or moved to a time still ahead. */
  readonly out: ReadonlySet<string>;
  /** What goes first, the earliest said first: Do now, and what was moved once its time has come. */
  readonly first: readonly string[];
  /** When something moved comes back, for a runner with nothing else to do to look again then. */
  readonly wakes: readonly number[];
}

const NONE: ChangesNow = { out: new Set(), first: [], wakes: [] };

/** The day's changes as they stand at `now`. */
export function changesAt(changes: readonly PlanChange[] | undefined, now: number): ChangesNow {
  if (!changes?.length) return NONE;
  const out = new Set<string>();
  const first: { key: string; since: number }[] = [];
  const wakes: number[] = [];
  for (const c of changes) {
    if (c.change === 'skip') out.add(c.key);
    else if (c.change === 'at' && c.at !== null && c.at > now) {
      out.add(c.key);
      wakes.push(c.at);
    } else first.push({ key: c.key, since: c.change === 'at' && c.at !== null ? c.at : c.made });
  }
  first.sort((a, b) => a.since - b.since);
  return { out, first: first.map((f) => f.key), wakes };
}

/**
 * The list's work with the day's changes: what's skipped or not yet due left out, and what goes first at the front,
 * in the order it was said. Everything else keeps its own order.
 */
export function workInLine<I extends PlanItem>(
  left: readonly Work<I>[],
  changed: ChangesNow,
): Work<I>[] {
  if (changed === NONE) return [...left];
  const kept = left.filter((work) => !changed.out.has(workChangeKey(work)));
  if (!changed.first.length) return kept;
  const rank = new Map(changed.first.map((key, i) => [key, i] as const));
  const front = kept
    .filter((work) => rank.has(workChangeKey(work)))
    .sort((a, b) => rank.get(workChangeKey(a))! - rank.get(workChangeKey(b))!);
  return front.length ? [...front, ...kept.filter((work) => !rank.has(workChangeKey(work)))] : kept;
}

/**
 * Today's list as the extension is given it: without anyone whose row is skipped today or moved to a time still
 * ahead. Only the people on it change: the limits, the goal and the rest are the list's own.
 */
export function listWithoutOut<
  I extends Pick<PlanItem, 'kind' | 'postId' | 'profileId' | 'name' | 'retry' | 'send'>,
  L extends { readonly items: readonly I[]; readonly partners?: readonly I[] | undefined },
>(list: L, changes: readonly PlanChange[] | undefined, now: number): L {
  const { out } = changesAt(changes, now);
  if (!out.size) return list;
  const stays = (item: I) => !itemChangeKeys(item).some((key) => out.has(key));
  return {
    ...list,
    items: list.items.filter(stays),
    ...(list.partners ? { partners: list.partners.filter(stays) } : {}),
  };
}
