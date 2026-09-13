/**
 * Weekly hours as instants, in TypeScript. The server uses `private.expand_schedule`; this mirror lets the
 * builder preview and the tests build windows with the same daylight-saving rule (see zoned.ts).
 */
import type { WeeklyHours } from '../config';
import { normalize, type Interval } from './intervals';
import { addDays, localDateOf, localInstant, weekdayOf } from './zoned';

export function expandWeeklyHours(
  hours: WeeklyHours,
  from: number,
  to: number,
  timeZone: string,
): Interval[] {
  const out: Interval[] = [];
  const last = localDateOf(to, timeZone);
  for (let date = addDays(localDateOf(from, timeZone), -1); date <= last; date = addDays(date, 1)) {
    const day = weekdayOf(date);
    for (const h of hours) {
      if (h.day !== day) continue;
      const start = localInstant(date, h.start, timeZone);
      const end = localInstant(date, h.end, timeZone);
      if (end > from && start < to) out.push({ start: Math.max(start, from), end: Math.min(end, to) });
    }
  }
  return normalize(out);
}
