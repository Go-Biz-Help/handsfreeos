/**
 * When waits end, in the workspace's time zone, with the calendar's zoned helpers: a length of time, the next
 * time the clock reads HH:MM on one of some days, and a time relative to a date on a record. Days and weeks
 * keep the wall clock (2 days after 3 PM is 3 PM, whatever daylight saving does). Pure.
 */
import {
  addDays,
  localDateOf,
  localInstant,
  weekdayOf,
  zonedParts,
  type DateOffset,
  type Duration,
} from '@hfos/core/server';

const UNIT_MS = { minutes: 60_000, hours: 3_600_000 } as const;

const pad = (n: number) => String(n).padStart(2, '0');

/** The wall-clock time (HH:MM) at an instant. */
export function clockOf(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

function shiftDays(at: number, days: number, clock: string | null, timeZone: string): number {
  return localInstant(
    addDays(localDateOf(at, timeZone), days),
    clock ?? clockOf(at, timeZone),
    timeZone,
  );
}

/** `from` plus a length of time. */
export function addDuration(from: number, d: Duration, timeZone: string): number {
  if (d.unit === 'minutes' || d.unit === 'hours') return from + d.amount * UNIT_MS[d.unit];
  return shiftDays(from, d.amount * (d.unit === 'weeks' ? 7 : 1), null, timeZone);
}

/** "2 hours after", "1 day before at 09:00", or "when" (amount 0) a date on a record. */
export function dateOffsetInstant(
  anchor: number,
  offset: DateOffset,
  at: string | null,
  timeZone: string,
): number {
  const sign = offset.direction === 'before' ? -1 : 1;
  if (offset.unit === 'minutes' || offset.unit === 'hours')
    return anchor + sign * offset.amount * UNIT_MS[offset.unit];
  return shiftDays(anchor, sign * offset.amount * (offset.unit === 'weeks' ? 7 : 1), at, timeZone);
}

/** The first time after `after` that the clock reads `at` on one of `days` (0 is Sunday). */
export function nextTimeOfDay(
  after: number,
  at: string,
  days: readonly number[],
  timeZone: string,
): number {
  const today = localDateOf(after, timeZone);
  for (let i = 0; i <= 8; i++) {
    const date = addDays(today, i);
    if (!days.includes(weekdayOf(date))) continue;
    const t = localInstant(date, at, timeZone);
    if (t > after) return t;
  }
  return after + 86_400_000;
}
