/**
 * Our own small repeat rule (not iCal RRULE): weekly on chosen weekdays, monthly on the same date, or
 * monthly on the same weekday ("2nd Tuesday"). Occurrences are local dates first, then instants through
 * the zone, so a 9:00 AM series stays at 9:00 AM across daylight-saving changes.
 */
import { z } from 'zod';
import {
  addDays,
  daysBetween,
  formatLocalDate,
  isClock,
  isLocalDate,
  localInstant,
  parseLocalDate,
  weekdayOf,
} from './zoned';

export const MAX_OCCURRENCES = 52;
export const MAX_SERIES_MONTHS = 12;

export const RecurrenceRule = z
  .object({
    freq: z.enum(['weekly', 'monthly_date', 'monthly_nth']),
    /** Every 1 to 12 weeks or months. */
    interval: z.int().min(1).max(12).default(1),
    /** Weekly only: 0 is Sunday. Empty means the first date's weekday. */
    weekdays: z.array(z.int().min(0).max(6)).max(7).default(() => []),
    count: z.int().min(1).max(MAX_OCCURRENCES).nullable().default(null),
    /** Last local date, inclusive; never more than 12 months after the first date. */
    until: z
      .string()
      .refine(isLocalDate, { error: 'Use a date like 2026-10-01.' })
      .nullable()
      .default(null),
    localTime: z
      .string()
      .refine((v) => isClock(v) && v !== '24:00', { error: 'Use a time like 09:00.' }),
  })
  .refine((r) => r.count !== null || r.until !== null, {
    error: 'Say how many times, or until when.',
    path: ['count'],
  });
export type RecurrenceRule = z.infer<typeof RecurrenceRule>;

export interface Occurrence {
  /** 0 for the first. */
  readonly index: number;
  /** Local date, YYYY-MM-DD. */
  readonly date: string;
  /** Epoch milliseconds. */
  readonly startsAt: number;
}

function monthDate(year: number, month: number, day: number): string | null {
  const date = formatLocalDate(year, month, day);
  return parseLocalDate(date).day === day ? date : null;
}

/** The nth (1–5) given weekday of a month, or null when the month has no such day. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): string | null {
  const first = weekdayOf(formatLocalDate(year, month, 1));
  return monthDate(year, month, 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7);
}

/** Local dates of a series starting on `firstDate` (included when it matches the rule). */
export function recurrenceDates(rule: RecurrenceRule, firstDate: string): string[] {
  const start = parseLocalDate(firstDate);
  const limit = Math.min(rule.count ?? MAX_OCCURRENCES, MAX_OCCURRENCES);
  const cap = formatLocalDate(start.year, start.month + MAX_SERIES_MONTHS, start.day);
  const last = rule.until && rule.until < cap ? rule.until : cap;
  const out: string[] = [];
  if (rule.freq === 'weekly') {
    const days = new Set(rule.weekdays.length ? rule.weekdays : [weekdayOf(firstDate)]);
    const weekStart = addDays(firstDate, -weekdayOf(firstDate));
    for (let date = firstDate; date <= last && out.length < limit; date = addDays(date, 1)) {
      const week = Math.floor(daysBetween(weekStart, date) / 7);
      if (week % rule.interval === 0 && days.has(weekdayOf(date))) out.push(date);
    }
    return out;
  }
  const weekday = weekdayOf(firstDate);
  const nth = Math.ceil(start.day / 7);
  for (let k = 0; out.length < limit; k += rule.interval) {
    const probe = parseLocalDate(formatLocalDate(start.year, start.month + k, 1));
    if (formatLocalDate(probe.year, probe.month, 1) > last) break;
    const date =
      rule.freq === 'monthly_date'
        ? monthDate(probe.year, probe.month, start.day)
        : nthWeekday(probe.year, probe.month, weekday, nth);
    if (date && date >= firstDate && date <= last) out.push(date);
  }
  return out;
}

/** Occurrences of a series as instants in the zone. */
export function expandRecurrence(rule: RecurrenceRule, firstDate: string, timeZone: string): Occurrence[] {
  return recurrenceDates(rule, firstDate).map((date, index) => ({
    index,
    date,
    startsAt: localInstant(date, rule.localTime, timeZone),
  }));
}
