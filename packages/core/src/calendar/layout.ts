/**
 * Placing appointments on a time grid: wall-clock minutes in a zone, side-by-side lanes for overlaps and
 * the stretches outside working hours. Pure and browser-safe, so the web's grid and these tests agree.
 *
 * The grid is wall-clock: 9:30 AM sits at 9:30 on every day, daylight saving or not. On the day clocks
 * fall back, the repeated hour shares its place; on the day they spring forward, the missing hour is never
 * booked (see zoned.ts for how those wall times read).
 */
import { addDays, localInstant, weekdayOf, zonedParts } from './engine/zoned';

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** A stretch of one local day in wall-clock minutes past midnight (0–1440). */
export interface MinuteSpan {
  readonly top: number;
  readonly bottom: number;
}

export interface GridItem {
  readonly id: string;
  /** Instants in milliseconds. */
  readonly start: number;
  readonly end: number;
}

export interface LanePlacement {
  /** Zero-based lane, left to right. */
  readonly lane: number;
  /** How many lanes its overlap group uses; the item is 1 / lanes wide. */
  readonly lanes: number;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Side-by-side lanes for overlapping items. Items that overlap, directly or through a chain, form a group;
 * each takes the leftmost lane free when it starts, and everything in a group shares the group's lane
 * count. Touching items (one ends as the next starts) don't overlap. Ties go longest first, then by id.
 */
export function overlapLanes(items: readonly GridItem[]): Map<string, LanePlacement> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end || byId(a.id, b.id));
  const out = new Map<string, LanePlacement>();
  let group: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const close = () => {
    for (const g of group) out.set(g.id, { lane: g.lane, lanes: laneEnds.length });
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    const end = Math.max(item.end, item.start);
    if (group.length && item.start >= groupEnd) close();
    let lane = laneEnds.findIndex((e) => e <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else laneEnds[lane] = end;
    group.push({ id: item.id, lane });
    groupEnd = group.length === 1 ? end : Math.max(groupEnd, end);
  }
  if (group.length) close();
  return out;
}

/** Minutes past midnight on the wall clock in a zone (0–1439). */
export function wallMinutes(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return p.hour * 60 + p.minute;
}

/**
 * Where an interval sits in one local day's column, clipped to that day, or null when it misses the day.
 * Something running past midnight reaches 1440; something from the day before starts at 0.
 */
export function placeOnDay(
  start: number,
  end: number,
  date: string,
  timeZone: string,
): MinuteSpan | null {
  const dayStart = localInstant(date, '00:00', timeZone);
  const dayEnd = localInstant(date, '24:00', timeZone);
  if (end < start || end <= dayStart || start >= dayEnd) return null;
  const top = start <= dayStart ? 0 : wallMinutes(start, timeZone);
  let bottom = end >= dayEnd ? DAY_MINUTES : wallMinutes(end, timeZone);
  // The repeated hour when clocks fall back can put the end's wall time before the start's.
  if (bottom < top)
    bottom = Math.min(
      DAY_MINUTES,
      top + Math.round((Math.min(end, dayEnd) - Math.max(start, dayStart)) / MINUTE),
    );
  return { top, bottom };
}

/** 570 → '09:30'; 1440 → '24:00'. */
export function minutesToClock(minutes: number): string {
  const m = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The instant a wall-clock minute of a local date happens in a zone (1440 is the next midnight). */
export function instantAt(date: string, minutes: number, timeZone: string): number {
  return localInstant(date, minutesToClock(minutes), timeZone);
}

/** Rounds to the nearest step (15 minutes unless told otherwise), kept inside the day. */
export function snapMinutes(minutes: number, step = 15): number {
  return Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes / step) * step));
}

/** The seven local dates of the week holding a date: Monday first, or Sunday with weekStartsOn 0. */
export function weekOf(date: string, weekStartsOn: 0 | 1 = 1): string[] {
  const back = (weekdayOf(date) - weekStartsOn + 7) % 7;
  const first = addDays(date, -back);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * The local dates of the month grid holding a date: whole weeks, so it opens with the days of the
 * previous month that share the first week and closes with the next month's that share the last.
 * Always six rows of seven, because a grid that changes height between months moves everything under
 * it when you step through them.
 */
export function monthGridOf(date: string, weekStartsOn: 0 | 1 = 1): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const back = (weekdayOf(first) - weekStartsOn + 7) % 7;
  const start = addDays(first, -back);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

/** Whole hours to show: at least the default span, widened to take in every given span. */
export function visibleHours(
  spans: readonly MinuteSpan[],
  at: { readonly from: number; readonly to: number } = { from: 7, to: 19 },
): { from: number; to: number } {
  let from = at.from;
  let to = at.to;
  for (const s of spans) {
    if (s.bottom <= s.top) continue;
    from = Math.min(from, Math.floor(s.top / 60));
    to = Math.max(to, Math.ceil(s.bottom / 60));
  }
  from = Math.max(0, from);
  return { from, to: Math.min(24, Math.max(to, from + 1)) };
}

/** Spans in order, overlapping and touching ones merged, clipped to the day, empty ones dropped. */
export function mergeMinuteSpans(spans: readonly MinuteSpan[]): MinuteSpan[] {
  const clipped = spans
    .map((s) => ({
      top: Math.max(0, Math.min(DAY_MINUTES, s.top)),
      bottom: Math.max(0, Math.min(DAY_MINUTES, s.bottom)),
    }))
    .filter((s) => s.bottom > s.top)
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const out: { top: number; bottom: number }[] = [];
  for (const s of clipped) {
    const last = out[out.length - 1];
    if (last && s.top <= last.bottom) last.bottom = Math.max(last.bottom, s.bottom);
    else out.push({ ...s });
  }
  return out;
}

/** The parts of a day outside the open spans, for shading time outside working hours. */
export function closedStretches(open: readonly MinuteSpan[]): MinuteSpan[] {
  const out: MinuteSpan[] = [];
  let cursor = 0;
  for (const s of mergeMinuteSpans(open)) {
    if (s.top > cursor) out.push({ top: cursor, bottom: s.top });
    cursor = Math.max(cursor, s.bottom);
  }
  if (cursor < DAY_MINUTES) out.push({ top: cursor, bottom: DAY_MINUTES });
  return out;
}
