/**
 * Time that counts only while the business is open (its `settings.openHours`, read with `openHoursOf`): "an
 * unanswered lead after 15 open-hours minutes" means 15 minutes from 4:55 PM with a 5 PM close is 8:10 AM the
 * next open day. With no open hours at all, it's plain time. Browser-safe; the worker's hand-off alert follows the
 * same rules.
 */
import type { WeeklyHours } from '../calendar/config';
import { addDays, localDateOf, localInstant, weekdayOf } from '../calendar/engine/zoned';

const DAY = 86_400_000;

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Open hours as instants, from the local day `from` falls on, for `days` days, earliest first. */
function spans(hours: WeeklyHours, timeZone: string, from: number, days: number): Span[] {
  const first = localDateOf(from, timeZone);
  const out: Span[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(first, i);
    const day = weekdayOf(date);
    for (const h of hours) {
      if (h.day !== day) continue;
      const start = localInstant(date, h.start, timeZone);
      const end = localInstant(date, h.end, timeZone);
      if (end > start) out.push({ start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The moment `ms` of open time has passed since `since`. */
export function addOpenTime(
  hours: WeeklyHours,
  timeZone: string,
  since: number,
  ms: number,
): number {
  if (hours.length === 0) return since + ms;
  let left = ms;
  for (const s of spans(hours, timeZone, since, 15)) {
    if (s.end <= since) continue;
    const start = Math.max(s.start, since);
    if (s.end - start >= left) return start + left;
    left -= s.end - start;
  }
  return since + ms;
}

/** How much open time lies between two instants, in ms. */
export function openTimeBetween(
  hours: WeeklyHours,
  timeZone: string,
  from: number,
  to: number,
): number {
  if (to <= from) return 0;
  if (hours.length === 0) return to - from;
  const days = Math.min(400, Math.ceil((to - from) / DAY) + 2);
  let total = 0;
  for (const s of spans(hours, timeZone, from, days)) {
    const start = Math.max(s.start, from);
    const end = Math.min(s.end, to);
    if (end > start) total += end - start;
  }
  return total;
}
