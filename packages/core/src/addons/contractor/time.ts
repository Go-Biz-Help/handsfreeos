/**
 * Time on a job (docs/contractor.md, "Time and job costing"; the owner's decision 10, 2026-11-10). Time comes from
 * the buttons a crew already taps on a visit: On the way starts travel time, Started starts work time, and Waiting
 * on parts, Done or going back to Scheduled stops it. A Break button pauses one person. What starts and stops, how
 * long a stretch is, when one left running is stopped, and what a fixed time may be: one copy of these rules, which
 * the server keeps and both apps and the AI read. Pure and browser-safe.
 */

export const TIME_KINDS = ['travel', 'work', 'break'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];

/** How a stretch came to be: the visit's status buttons, the Break button, or added by someone who may fix time. */
export const TIME_SOURCES = ['status', 'break', 'added'] as const;
export type TimeSource = (typeof TIME_SOURCES)[number];

/** Time on the job that counts as labor: travel and work. A break doesn't. */
export const isPaid = (kind: TimeKind): boolean => kind !== 'break';

/**
 * What a visit's status does to the clocks of the people on it: On the way starts travel, Started starts work, and
 * anything else (Scheduled, Waiting on parts, Done, Cancelled) stops them.
 */
export function clockFor(status: string): 'travel' | 'work' | null {
  if (status === 'on_the_way') return 'travel';
  if (status === 'in_progress') return 'work';
  return null;
}

/** A stretch left running this long is stopped on its own, and someone who may fix time is told. */
export const MAX_RUNNING_HOURS = 12;
/** The longest stretch someone can type when fixing time. */
export const MAX_FIXED_HOURS = 24;

const HOUR_MS = 3_600_000;

/** When a stretch that's still running is stopped on its own. */
export const limitOf = (startedAt: number): number => startedAt + MAX_RUNNING_HOURS * HOUR_MS;

export interface Stretch {
  readonly kind: TimeKind;
  readonly startedAt: number;
  /** Null while it's running. */
  readonly endedAt: number | null;
}

/** How long a stretch is, in seconds: up to now while it's running. Never below nothing. */
export const secondsOf = (e: Pick<Stretch, 'startedAt' | 'endedAt'>, now: number): number =>
  Math.max(0, Math.round(((e.endedAt ?? now) - e.startedAt) / 1000));

/** Seconds as hours to two decimal places, as a budget's labor hours are kept. */
export const hoursOf = (seconds: number): number => Math.round(seconds / 36) / 100;

export interface TimeTotals {
  readonly workSeconds: number;
  readonly travelSeconds: number;
  readonly breakSeconds: number;
  /** Work and travel: the time that's labor. */
  readonly paidSeconds: number;
  /** How many stretches are running now. */
  readonly running: number;
}

export function totalsOf(entries: readonly Stretch[], now: number): TimeTotals {
  let work = 0;
  let travel = 0;
  let rest = 0;
  let running = 0;
  for (const e of entries) {
    const s = secondsOf(e, now);
    if (e.kind === 'work') work += s;
    else if (e.kind === 'travel') travel += s;
    else rest += s;
    if (e.endedAt === null) running += 1;
  }
  return {
    workSeconds: work,
    travelSeconds: travel,
    breakSeconds: rest,
    paidSeconds: work + travel,
    running,
  };
}

/** "2 h 15 min", "3 h", "45 min", or "under a minute". */
export function durationWords(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return 'under a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** What a stretch cost the business: its time at what an hour cost. A break costs nothing; so does no cost. */
export const stretchCostCents = (kind: TimeKind, seconds: number, rateCents: number | null) =>
  !isPaid(kind) || rateCents === null ? 0 : Math.round((seconds / 3600) * rateCents);

/** Why a fixed time can't be kept. */
export type FixProblem = 'ends_first' | 'too_long' | 'in_future';

/** A fixed stretch ends after it starts, is no longer than a day, and isn't still to come. */
export function fixProblem(startedAt: number, endedAt: number, now: number): FixProblem | null {
  if (endedAt <= startedAt) return 'ends_first';
  if (endedAt - startedAt > MAX_FIXED_HOURS * HOUR_MS) return 'too_long';
  // A minute's grace: the clock on someone's computer is never quite the server's.
  if (endedAt > now + 60_000) return 'in_future';
  return null;
}
