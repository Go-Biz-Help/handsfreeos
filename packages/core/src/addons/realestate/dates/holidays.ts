/**
 * US federal holidays, as observed (HANDSFREEOS_REAL_ESTATE_IMPLEMENTATION_PLAN.md, "Dates"; Chris, 2026-09-30:
 * business days are US-wide, with no state rules). Browser-safe and pure.
 *
 * The eleven holidays of 5 U.S.C. 6103(a), Juneteenth from 2021. One that falls on a Saturday is observed the Friday
 * before, and one on a Sunday the Monday after, so New Year's Day on a Saturday is observed on the last day of the
 * year before. Every deadline worked out from these carries HOLIDAY_RULES_VERSION in its trace, so a date can be
 * replayed exactly after the rules change.
 */
import { addDays, formatLocalDate, weekdayOf } from '../../../calendar/engine/zoned';

/** Bumped whenever the list or the observing rule changes. */
export const HOLIDAY_RULES_VERSION = 'us-federal-1';

export interface Holiday {
  /** The day it's observed: the day that isn't a business day. */
  readonly date: string;
  readonly name: string;
  /** Its own date, when that's a weekend. */
  readonly actual: string;
}

/** The `n`th `weekday` (0 is Sunday) of a month; `n` of -1 is the last. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = formatLocalDate(year, month, 1);
    const shift = (weekday - weekdayOf(first) + 7) % 7;
    return addDays(first, shift + (n - 1) * 7);
  }
  const last = formatLocalDate(year, month + 1, 0);
  const back = (weekdayOf(last) - weekday + 7) % 7;
  return addDays(last, -back);
}

/** Each holiday's own date in a year, before observing. */
function actualHolidays(year: number): { date: string; name: string }[] {
  const list = [
    { date: formatLocalDate(year, 1, 1), name: 'New Year’s Day' },
    { date: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
    { date: nthWeekday(year, 2, 1, 3), name: 'Washington’s Birthday' },
    { date: nthWeekday(year, 5, 1, -1), name: 'Memorial Day' },
    { date: formatLocalDate(year, 7, 4), name: 'Independence Day' },
    { date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    { date: formatLocalDate(year, 11, 11), name: 'Veterans Day' },
    { date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' },
    { date: formatLocalDate(year, 12, 25), name: 'Christmas Day' },
  ];
  if (year >= 2021)
    list.splice(4, 0, {
      date: formatLocalDate(year, 6, 19),
      name: 'Juneteenth National Independence Day',
    });
  return list;
}

const observe = (date: string): string => {
  const day = weekdayOf(date);
  return day === 6 ? addDays(date, -1) : day === 0 ? addDays(date, 1) : date;
};

const byYear = new Map<number, readonly Holiday[]>();

/** The holidays observed in a year, in date order (New Year's Day of the next year, when observed on Dec 31). */
export function federalHolidays(year: number): readonly Holiday[] {
  const known = byYear.get(year);
  if (known) return known;
  const list = [...actualHolidays(year), ...actualHolidays(year + 1).slice(0, 1)]
    .map((h) => ({ date: observe(h.date), name: h.name, actual: h.date }))
    .filter((h) => h.date.startsWith(`${String(year).padStart(4, '0')}-`))
    .sort((a, b) => a.date.localeCompare(b.date));
  byYear.set(year, list);
  return list;
}

/** The holiday observed on a local date, or null. */
export function holidayOn(date: string): Holiday | null {
  return federalHolidays(Number(date.slice(0, 4))).find((h) => h.date === date) ?? null;
}
