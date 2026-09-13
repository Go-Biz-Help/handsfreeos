/**
 * Dates and times on the booking pages, always in the business's time zone ("Times in Central Time").
 * Clock times are built from parts, so the narrow space some browsers put before AM never leaks in.
 */
import { localDateOf, parseLocalDate, weekdayOf, zonedParts } from '@hfos/core';

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
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

function clock(iso: string, timeZone: string): { hm: string; ap: string } {
  const p = zonedParts(Date.parse(iso), timeZone);
  const h = p.hour % 12 || 12;
  return { hm: `${h}:${String(p.minute).padStart(2, '0')}`, ap: p.hour < 12 ? 'AM' : 'PM' };
}

/** "10:00 AM" */
export function timeOf(iso: string, timeZone: string): string {
  const c = clock(iso, timeZone);
  return `${c.hm} ${c.ap}`;
}

/** "10:00–11:00 AM", or "11:00 AM–1:00 PM" across noon. */
export function timeRange(startIso: string, endIso: string, timeZone: string): string {
  const a = clock(startIso, timeZone);
  const b = clock(endIso, timeZone);
  return a.ap === b.ap ? `${a.hm}–${b.hm} ${b.ap}` : `${a.hm} ${a.ap}–${b.hm} ${b.ap}`;
}

/** The business-local date ('YYYY-MM-DD') an instant falls on. */
export const localDate = (iso: string, timeZone: string): string =>
  localDateOf(Date.parse(iso), timeZone);

export const isMorning = (iso: string, timeZone: string): boolean =>
  zonedParts(Date.parse(iso), timeZone).hour < 12;

/** "Fri, Sep 18" for a local date. */
export function dateShort(date: string): string {
  const p = parseLocalDate(date);
  return `${WEEKDAY_SHORT[weekdayOf(date)]}, ${MONTHS[p.month - 1]!.slice(0, 3)} ${p.day}`;
}

/** "Friday, September 18" for a local date. */
export function dateLong(date: string): string {
  const p = parseLocalDate(date);
  return `${WEEKDAY_LONG[weekdayOf(date)]}, ${MONTHS[p.month - 1]} ${p.day}`;
}

/** "September 2026" */
export function monthTitle(date: string): string {
  const p = parseLocalDate(date);
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

/** "Fri, Sep 18" for an instant. */
export const dayShort = (iso: string, timeZone: string) => dateShort(localDate(iso, timeZone));
/** "Friday, September 18" for an instant. */
export const dayLong = (iso: string, timeZone: string) => dateLong(localDate(iso, timeZone));

/** 60 → "1 hour", 120 → "2 hours", 90 → "1 h 30 min", 45 → "45 min". */
export function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

export const hoursLabel = (h: number): string => (h === 1 ? '1 hour' : `${h} hours`);

/** $89, or $89.50. */
export function money(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars)
    ? `$${dollars.toLocaleString('en-US')}`
    : `$${dollars.toFixed(2)}`;
}

/** "Priya", "Priya and Marco", "Ana, Priya and Marco". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export const seatsLabel = (n: number): string => `${n} ${n === 1 ? 'seat' : 'seats'}`;
