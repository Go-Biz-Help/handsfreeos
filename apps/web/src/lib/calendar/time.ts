/**
 * Dates and times on the calendar screens, always in the workspace's time zone and never the browser's: a
 * teammate travelling in Los Angeles still sees the Chicago business's 9 AM at 9 AM, labelled Central Time.
 * Formatting is done by hand, so the server and the browser print exactly the same characters.
 */
import { localDateOf, parseLocalDate, weekdayOf, zonedParts } from '@hfos/core';

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
      label =
        new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longGeneric' })
          .formatToParts(Date.UTC(2026, 0, 15))
          .find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
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
export function clockLabel(minutes: number, meridiem = true): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const text = `${h % 12 || 12}:${String(m % 60).padStart(2, '0')}`;
  return meridiem ? `${text} ${h < 12 ? 'AM' : 'PM'}` : text;
}

/** Minutes past midnight on the wall clock in the zone. */
export function minutesOf(at: number | string, timeZone: string): number {
  const p = zonedParts(ms(at), timeZone);
  return p.hour * 60 + p.minute;
}

/** "9:30 AM". */
export function fmtTime(at: number | string, timeZone: string): string {
  return clockLabel(minutesOf(at, timeZone));
}

/** "8:00–9:00 AM", "11:00 AM–12:30 PM" (one meridiem when both ends share it). */
export function fmtRange(start: number | string, end: number | string, timeZone: string): string {
  const a = minutesOf(start, timeZone);
  const b = minutesOf(end, timeZone);
  const sameHalf = a < 720 === b < 720 && b >= a;
  return `${clockLabel(a, !sameHalf)}–${clockLabel(b)}`;
}

/** The local date ('YYYY-MM-DD') of an instant in the zone. */
export const dateOf = (at: number | string, timeZone: string): string =>
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

/** Three-letter weekday of a local date: "Mon". */
export const weekdayShort = (date: string): string => short(WEEKDAYS[weekdayOf(date)]!);

/** "Thursday, September 17 · 1:30–3:30 PM" (long) or "Thu, Sep 17 · 1:30–3:30 PM". */
export function fmtWhen(
  start: number | string,
  end: number | string,
  timeZone: string,
  long = false,
): string {
  const date = dateOf(start, timeZone);
  return `${long ? fmtDateLong(date) : fmtDateShort(date)} · ${fmtRange(start, end, timeZone)}`;
}

/** "Fri, Sep 18 at 10:00 AM". */
export function fmtAt(at: number | string, timeZone: string): string {
  return `${fmtDateShort(dateOf(at, timeZone))} at ${fmtTime(at, timeZone)}`;
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

/** Start times for pickers, every 15 minutes: [minutes, "9:30 AM"]. */
export const TIME_OPTIONS: readonly (readonly [number, string])[] = Array.from(
  { length: 96 },
  (_, i) => [i * 15, clockLabel(i * 15)] as const,
);
