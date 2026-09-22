/**
 * Dates and times on the calendar, always in the business's time zone and never the reader's: a teammate travelling
 * in Los Angeles still sees the Chicago business's 9 AM at 9 AM, labelled Central Time.
 *
 * Formatting is done by hand rather than through `Intl`, so a server, a browser and Hermes on a phone print exactly
 * the same characters — the one place `Intl` is used (`zoneLabel`) has its spaces flattened by `plainSpaces`.
 *
 * This was `apps/web/src/lib/calendar/time.ts`; the web now re-exports it, and the phone's Calendar reads it too
 * (M10 step 16). `clockLabel` there is `clockOfMinutes` here, because core's Action Center already has a
 * `clockLabel(at, timeZone)` of its own.
 */
import { intlTimeZone } from '../intl/engine-zones';
import { plainSpaces } from '../intl/spaces';
import { localDateOf, parseLocalDate, weekdayOf, zonedParts } from './engine/zoned';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const short = (s: string) => s.slice(0, 3);
const ms = (at: number | string) => (typeof at === 'number' ? at : Date.parse(at));

const zoneLabels = new Map<string, string>();

/** "Central Time" for America/Chicago; the zone's own name when there is no friendlier one. */
export function zoneLabel(timeZone: string): string {
  let label = zoneLabels.get(timeZone);
  if (!label) {
    try {
      label = plainSpaces(
        new Intl.DateTimeFormat('en-US', {
          timeZone: intlTimeZone(timeZone),
          timeZoneName: 'longGeneric',
        })
          .formatToParts(Date.UTC(2026, 0, 15))
          .find((p) => p.type === 'timeZoneName')?.value ?? timeZone,
      );
    } catch {
      label = timeZone;
    }
    zoneLabels.set(timeZone, label);
  }
  return label;
}

/** 7 → "7 AM", 12 → "12 PM", 0 and 24 → "12 AM". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Minutes past midnight as a clock: 570 → "9:30 AM"; without the meridiem when asked. */
export function clockOfMinutes(minutes: number, meridiem = true): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const text = `${h % 12 || 12}:${String(m % 60).padStart(2, '0')}`;
  return meridiem ? `${text} ${h < 12 ? 'AM' : 'PM'}` : text;
}

/** Minutes past midnight on the wall clock in the zone. */
export function minutesPastMidnight(at: number | string, timeZone: string): number {
  const p = zonedParts(ms(at), timeZone);
  return p.hour * 60 + p.minute;
}

/** "9:30 AM". */
export function fmtTime(at: number | string, timeZone: string): string {
  return clockOfMinutes(minutesPastMidnight(at, timeZone));
}

/** "8:00–9:00 AM", "11:00 AM–12:30 PM" (one meridiem when both ends share it). */
export function fmtRange(start: number | string, end: number | string, timeZone: string): string {
  const a = minutesPastMidnight(start, timeZone);
  const b = minutesPastMidnight(end, timeZone);
  const sameHalf = a < 720 === b < 720 && b >= a;
  return `${clockOfMinutes(a, !sameHalf)}–${clockOfMinutes(b)}`;
}

/** The local date ('YYYY-MM-DD') of an instant in the zone. */
export const localDayOf = (at: number | string, timeZone: string): string =>
  localDateOf(ms(at), timeZone);

export const todayIn = (timeZone: string): string => localDateOf(Date.now(), timeZone);

/** "Thursday, September 17". */
export function fmtDateLong(date: string): string {
  const p = parseLocalDate(date);
  return `${WEEKDAYS[weekdayOf(date)]}, ${MONTHS[p.month - 1]} ${p.day}`;
}

/** "Thu, Sep 17". */
export function fmtDateShort(date: string): string {
  const p = parseLocalDate(date);
  return `${short(WEEKDAYS[weekdayOf(date)]!)}, ${short(MONTHS[p.month - 1]!)} ${p.day}`;
}

/** "Sep 17" (with the year when it isn't this one). */
export function fmtMonthDay(date: string, thisYear?: number): string {
  const p = parseLocalDate(date);
  const base = `${short(MONTHS[p.month - 1]!)} ${p.day}`;
  return thisYear !== undefined && p.year !== thisYear ? `${base}, ${p.year}` : base;
}

/** "September 2026". */
export function fmtMonthYear(date: string): string {
  const p = parseLocalDate(date);
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

/** "September 14–20, 2026", "September 28 – October 4, 2026", "December 28, 2026 – January 3, 2027". */
export function fmtWeekRange(first: string, last: string): string {
  const a = parseLocalDate(first);
  const b = parseLocalDate(last);
  if (a.year !== b.year)
    return `${MONTHS[a.month - 1]} ${a.day}, ${a.year} – ${MONTHS[b.month - 1]} ${b.day}, ${b.year}`;
  if (a.month !== b.month)
    return `${MONTHS[a.month - 1]} ${a.day} – ${MONTHS[b.month - 1]} ${b.day}, ${b.year}`;
  return `${MONTHS[a.month - 1]} ${a.day}–${b.day}, ${b.year}`;
}

/**
 * The same week where there is no room for the long one — the phone's calendar heading: "Sep 20–26",
 * "Sep 28 – Oct 4". No year: a week is always one the reader has just stepped to.
 */
export function fmtWeekRangeShort(first: string, last: string): string {
  const a = parseLocalDate(first);
  const b = parseLocalDate(last);
  const from = `${short(MONTHS[a.month - 1]!)} ${a.day}`;
  if (a.month !== b.month || a.year !== b.year)
    return `${from} – ${short(MONTHS[b.month - 1]!)} ${b.day}`;
  return `${from}–${b.day}`;
}

/** Three-letter weekday of a local date: "Mon". */
export const weekdayShort = (date: string): string => short(WEEKDAYS[weekdayOf(date)]!);

/** "Thursday, September 17 · 1:30–3:30 PM" (long) or "Thu, Sep 17 · 1:30–3:30 PM". */
export function fmtWhen(
  start: number | string,
  end: number | string,
  timeZone: string,
  long = false,
): string {
  const date = localDayOf(start, timeZone);
  return `${long ? fmtDateLong(date) : fmtDateShort(date)} · ${fmtRange(start, end, timeZone)}`;
}

/** "Fri, Sep 18 at 10:00 AM". */
export function fmtAt(at: number | string, timeZone: string): string {
  return `${fmtDateShort(localDayOf(at, timeZone))} at ${fmtTime(at, timeZone)}`;
}

/** "1 h 30 min", "45 min", "2 h". */
export function fmtLength(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Minutes between two instants. */
export const minutesBetween = (start: number | string, end: number | string): number =>
  Math.round((ms(end) - ms(start)) / 60_000);

/**
 * "Today 4:00 PM", "Wed 4:00 PM" within a week either way, else "Sep 24, 4:00 PM" — how the appointment sheet dates
 * a confirmation or a reminder that is close to now.
 */
export function dayTime(at: number | string, timeZone: string, now?: number): string {
  const d = localDayOf(at, timeZone);
  const today = localDateOf(now ?? Date.now(), timeZone);
  const days = Math.round(
    (Date.parse(`${d}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000,
  );
  if (days === 0) return `Today ${fmtTime(at, timeZone)}`;
  if (Math.abs(days) < 7) return `${weekdayShort(d)} ${fmtTime(at, timeZone)}`;
  return `${fmtMonthDay(d, Number(today.slice(0, 4)))}, ${fmtTime(at, timeZone)}`;
}

/** Start times for pickers, every 15 minutes: [minutes, "9:30 AM"]. */
export const TIME_OPTIONS: readonly (readonly [number, string])[] = Array.from(
  { length: 96 },
  (_, i) => [i * 15, clockOfMinutes(i * 15)] as const,
);

/** TIME_OPTIONS, plus `minutes` itself when it falls between the quarter hours (an offered time, an odd start). */
export function timeOptionsWith(minutes: number): readonly (readonly [number, string])[] {
  return TIME_OPTIONS.some(([m]) => m === minutes)
    ? TIME_OPTIONS
    : [...TIME_OPTIONS, [minutes, clockOfMinutes(minutes)] as const].sort((a, b) => a[0] - b[0]);
}
