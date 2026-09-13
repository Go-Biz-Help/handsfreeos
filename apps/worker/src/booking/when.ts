/**
 * Dates and times in customers' texts and emails, always in the calendar's time zone: "Fri, Sep 18",
 * "Friday, September 18", "10:00 AM", "10:00–11:00 AM", "Central Time" and "CT". Built from parts, like the
 * booking pages' own format.ts, so no locale spacing sneaks into a text.
 */
import { addDays, localDateOf, zonedParts } from '@hfos/core/server';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

const ms = (at: Date | number): number => (typeof at === 'number' ? at : at.getTime());

function clockParts(at: Date | number, timeZone: string): { hm: string; ap: string } {
  const p = zonedParts(ms(at), timeZone);
  return {
    hm: `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')}`,
    ap: p.hour < 12 ? 'AM' : 'PM',
  };
}

/** "10:00 AM" */
export function clock(at: Date | number, timeZone: string): string {
  const c = clockParts(at, timeZone);
  return `${c.hm} ${c.ap}`;
}

/** "10:00–11:00 AM", or "11:00 AM–1:00 PM" across noon. Emails only: the dash isn't a texting character. */
export function timeRange(start: Date | number, end: Date | number, timeZone: string): string {
  const a = clockParts(start, timeZone);
  const b = clockParts(end, timeZone);
  return a.ap === b.ap ? `${a.hm}–${b.hm} ${b.ap}` : `${a.hm} ${a.ap}–${b.hm} ${b.ap}`;
}

/** "Fri, Sep 18" */
export function dayShort(at: Date | number, timeZone: string): string {
  const p = zonedParts(ms(at), timeZone);
  return `${WEEKDAY_SHORT[p.weekday]}, ${MONTHS[p.month - 1]!.slice(0, 3)} ${p.day}`;
}

/** "Friday, September 18" */
export function dayLong(at: Date | number, timeZone: string): string {
  const p = zonedParts(ms(at), timeZone);
  return `${WEEKDAY_LONG[p.weekday]}, ${MONTHS[p.month - 1]} ${p.day}`;
}

/** "Fri" */
export function weekdayShort(at: Date | number, timeZone: string): string {
  return WEEKDAY_SHORT[zonedParts(ms(at), timeZone).weekday]!;
}

/** "Central Time" (long) or "CT" (short) for America/Chicago. */
export function zoneName(timeZone: string, style: 'long' | 'short', at: Date | number): string {
  try {
    return (
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        timeZoneName: style === 'long' ? 'longGeneric' : 'shortGeneric',
      })
        .formatToParts(ms(at))
        .find((p) => p.type === 'timeZoneName')?.value ?? timeZone
    );
  } catch {
    return timeZone;
  }
}

/** 'today' or 'tomorrow' where the business is, as of `now`; null for any other day. */
export function relativeDay(
  at: Date | number,
  now: number,
  timeZone: string,
): 'today' | 'tomorrow' | null {
  const day = localDateOf(ms(at), timeZone);
  const today = localDateOf(now, timeZone);
  if (day === today) return 'today';
  if (day === addDays(today, 1)) return 'tomorrow';
  return null;
}

/** Whether two instants fall on the same local date. */
export const sameLocalDay = (a: number, b: number, timeZone: string): boolean =>
  localDateOf(a, timeZone) === localDateOf(b, timeZone);

/** 60 → "1 hour", 120 → "2 hours", 90 → "1 h 30 min", 45 → "45 min". */
export function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

/** 1 → "1 hour", 24 → "24 hours". */
export const hoursLabel = (h: number): string => (h === 1 ? '1 hour' : `${h} hours`);
