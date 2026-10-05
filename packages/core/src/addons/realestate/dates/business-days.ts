/**
 * Business days (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Dates"): Monday to Friday, minus the US federal
 * holidays as observed (./holidays.ts), minus any days the business itself is closed. Local dates only: which
 * instant a day starts is the time zone's business, not this file's. Browser-safe and pure.
 */
import { addDays, weekdayOf } from '../../../calendar/engine/zoned';
import { holidayOn } from './holidays';

export interface BusinessCalendar {
  /** Days the business is closed besides weekends and federal holidays ('2026-12-24'), with a word for each. */
  readonly closedDays: ReadonlyMap<string, string>;
}

export const NO_CLOSED_DAYS: BusinessCalendar = { closedDays: new Map() };

/** The business's closed days as Deal settings keeps them (`closedDays`: date → name); anything else is none. */
export function calendarOf(closed: unknown): BusinessCalendar {
  if (!closed || typeof closed !== 'object' || Array.isArray(closed)) return NO_CLOSED_DAYS;
  const days = Object.entries(closed as Record<string, unknown>).filter(
    (e): e is [string, string] => /^\d{4}-\d{2}-\d{2}$/.test(e[0]) && typeof e[1] === 'string',
  );
  return { closedDays: new Map(days) };
}

/** Why a day isn't a business day. */
export type DayOff =
  | { readonly reason: 'weekend' }
  | { readonly reason: 'holiday'; readonly name: string }
  | { readonly reason: 'closed'; readonly name: string };

/** Why a local date isn't a business day, or null when it is. */
export function dayOff(date: string, calendar: BusinessCalendar = NO_CLOSED_DAYS): DayOff | null {
  const weekday = weekdayOf(date);
  if (weekday === 0 || weekday === 6) return { reason: 'weekend' };
  const holiday = holidayOn(date);
  if (holiday) return { reason: 'holiday', name: holiday.name };
  const closed = calendar.closedDays.get(date);
  return closed !== undefined ? { reason: 'closed', name: closed || 'Closed' } : null;
}

export const isBusinessDay = (date: string, calendar: BusinessCalendar = NO_CLOSED_DAYS) =>
  dayOff(date, calendar) === null;

export interface SkippedDay {
  readonly date: string;
  readonly off: DayOff;
}

/**
 * `n` business days after a date (before it, when negative): the date itself never counts, and every day passed
 * over is listed, for the trace. Zero is the date itself, whatever it is.
 */
export function addBusinessDays(
  date: string,
  n: number,
  calendar: BusinessCalendar = NO_CLOSED_DAYS,
): { readonly date: string; readonly skipped: readonly SkippedDay[] } {
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  let at = date;
  const skipped: SkippedDay[] = [];
  while (left > 0) {
    at = addDays(at, step);
    const off = dayOff(at, calendar);
    if (off) skipped.push({ date: at, off });
    else left -= 1;
  }
  return { date: at, skipped };
}

/** The first business day on or after a date. */
export function nextBusinessDay(date: string, calendar: BusinessCalendar = NO_CLOSED_DAYS): string {
  let at = date;
  while (!isBusinessDay(at, calendar)) at = addDays(at, 1);
  return at;
}

/**
 * Business days from one date to a later one: the days after `from`, up to and including `to`. Negative when `to`
 * comes first.
 */
export function businessDaysBetween(
  from: string,
  to: string,
  calendar: BusinessCalendar = NO_CLOSED_DAYS,
): number {
  if (from === to) return 0;
  const [a, b, sign] = from < to ? [from, to, 1] : [to, from, -1];
  let count = 0;
  for (let at = addDays(a, 1); at <= b; at = addDays(at, 1))
    if (isBusinessDay(at, calendar)) count += 1;
  return count * sign;
}
