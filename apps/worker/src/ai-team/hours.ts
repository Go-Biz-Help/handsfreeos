/**
 * When things happen for the AI teammate, from the business's open hours and the teammate's own working hours.
 * Pure, so the tests pin every case:
 * - when the business next opens, and what the hand-off line promises ("someone from our team will reply first
 *   thing tomorrow morning");
 * - when a stretch of open time has passed since a hand-off (M3's unanswered alert: 15 minutes of open hours);
 * - when the teammate is next at work (first messages and nudges wait for it).
 */
import {
  addDays,
  EXPECTATION_SLOT,
  localDateOf,
  localInstant,
  localMinutes,
  plainSpaces,
  weekdayOf,
  type TeammateConfig,
  type WeeklyHours,
} from '@hfos/core/server';
import { workingNow } from './gates';

const DAY = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Span {
  readonly start: number;
  readonly end: number;
}

/** Weekly hours as instants, from the local day `from` falls on, for `days` days, earliest first. */
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

/** When the business is next open: `now` while it's open, else when it opens; null when it has no open hours. */
export function nextOpenAt(hours: WeeklyHours, timeZone: string, now: number): number | null {
  for (const s of spans(hours, timeZone, now, 8)) if (s.end > now) return Math.max(s.start, now);
  return null;
}

/**
 * The moment `ms` of open time has passed since `since`: 15 minutes from 4:55 PM with a 5 PM close is 8:10 AM
 * the next open day. With no open hours at all, it's plain time.
 */
export function afterOpenTime(
  hours: WeeklyHours,
  timeZone: string,
  since: number,
  ms: number,
): number {
  let left = ms;
  for (const s of spans(hours, timeZone, since, 15)) {
    if (s.end <= since) continue;
    const start = Math.max(s.start, since);
    if (s.end - start >= left) return start + left;
    left -= s.end - start;
  }
  return since + ms;
}

/**
 * When the teammate is next at work: `now` while it is, else the next start of its own hours, or (working
 * after hours) the next time the business closes. A day from now when its hours never come round.
 */
export function nextWorkingAt(
  config: TeammateConfig,
  openHours: WeeklyHours,
  timeZone: string,
  now: number,
): number {
  if (workingNow(config, openHours, timeZone, now)) return now;
  const candidates =
    config.hours.mode === 'custom'
      ? spans(config.hours.custom, timeZone, now, 8).map((s) => s.start)
      : spans(openHours, timeZone, now, 8).map((s) => s.end);
  for (const at of candidates.sort((x, y) => x - y))
    if (at > now && workingNow(config, openHours, timeZone, at)) return at;
  return now + DAY;
}

/** "8 AM", "8:30 AM", "1 PM". */
function shortClock(at: number, timeZone: string): string {
  return plainSpaces(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at),
  ).replace(':00', '');
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

const WHO = 'someone from our team will reply';

/**
 * When the customer will hear from a person, for the hand-off line's {expectation}: shortly while the business
 * is open; otherwise when it next opens ("first thing tomorrow morning", "on Monday once we open at 1 PM").
 */
export function handoffExpectation(hours: WeeklyHours, timeZone: string, now: number): string {
  const next = nextOpenAt(hours, timeZone, now);
  if (next === null) return `${WHO} as soon as they can`;
  if (next <= now) return `${WHO} shortly`;
  const clock = shortClock(next, timeZone);
  const morning = localMinutes(new Date(next), timeZone) < 12 * 60;
  const days = daysBetween(localDateOf(now, timeZone), localDateOf(next, timeZone));
  if (days === 0)
    return morning ? `${WHO} first thing this morning` : `${WHO} once we open at ${clock}`;
  if (days === 1)
    return morning
      ? `${WHO} first thing tomorrow morning`
      : `${WHO} tomorrow once we open at ${clock}`;
  const weekday = WEEKDAYS[weekdayOf(localDateOf(next, timeZone))]!;
  return morning
    ? `${WHO} first thing ${weekday} morning`
    : `${WHO} on ${weekday} once we open at ${clock}`;
}

/**
 * The business's hand-off message with {expectation} filled in: capitalised where it starts a sentence, and
 * ending in a full stop when the business left it off after the slot.
 */
export function handoffLine(template: string, expectation: string): string {
  const parts = template.split(EXPECTATION_SLOT);
  let out = parts[0] ?? '';
  for (const rest of parts.slice(1)) {
    const starts = /(^|[.!?]\s+|\n\s*)$/.test(out);
    out +=
      (starts ? expectation.charAt(0).toUpperCase() + expectation.slice(1) : expectation) + rest;
  }
  const line = out.replace(/[ \t]{2,}/g, ' ').trim();
  return /[.!?)"'”’]$/.test(line) ? line : `${line}.`;
}
