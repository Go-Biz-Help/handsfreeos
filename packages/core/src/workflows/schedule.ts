/**
 * When a schedule trigger fires next, in the workspace's time zone. Wall-clock times follow the calendar's
 * zoned helpers (the Postgres rule): a time skipped by spring-forward runs an hour later on the clock, and
 * a time that happens twice at fall-back runs at the second one. Browser-safe.
 */
import {
  addDays,
  formatLocalDate,
  localDateOf,
  localInstant,
  parseLocalDate,
  weekdayOf,
} from '../calendar/engine/zoned';
import type { Cadence } from './definition';

function monthlyDate(year: number, month: number, day: number | 'last'): string {
  // Day 0 of the next month is the last day of this one; formatLocalDate carries month overflow.
  return day === 'last' ? formatLocalDate(year, month + 1, 0) : formatLocalDate(year, month, day);
}

/** The first occurrence strictly after `after` (epoch milliseconds). */
export function nextOccurrence(cadence: Cadence, after: Date | number, timeZone: string): number {
  const t = typeof after === 'number' ? after : after.getTime();
  const today = localDateOf(t, timeZone);
  if (cadence.every === 'weekly') {
    for (let i = 0; i <= 8; i++) {
      const date = addDays(today, i);
      if (!cadence.days.includes(weekdayOf(date))) continue;
      const at = localInstant(date, cadence.at, timeZone);
      if (at > t) return at;
    }
  } else {
    const { year, month } = parseLocalDate(today);
    for (let i = 0; i <= 13; i++) {
      const at = localInstant(monthlyDate(year, month + i, cadence.day), cadence.at, timeZone);
      if (at > t) return at;
    }
  }
  throw new RangeError('This schedule never runs.');
}

/** The next `count` occurrences after `after`, for previews ("Next: Mon 9:00 AM, …"). */
export function upcomingOccurrences(
  cadence: Cadence,
  after: Date | number,
  timeZone: string,
  count = 3,
): number[] {
  const out: number[] = [];
  let t = typeof after === 'number' ? after : after.getTime();
  while (out.length < count) {
    t = nextOccurrence(cadence, t, timeZone);
    out.push(t);
  }
  return out;
}
