/**
 * The Calendar's List, Week and Month looks, and picking many posts on it (the owner, 15 Nov 2026; the design they
 * OK'd): which days each look shows, which filter a post falls under, and what the picked posts can do. The web and
 * the phone both read these, so the two decide alike. Browser-safe and pure.
 */
import { addDays, parseLocalDate, weekdayOf } from '../../calendar/engine/zoned';
import { canLook, canRedo, PICKING, type ContentState } from './calendar';

/** How the Calendar looks: today's list (the default), a week, or a month. */
export const CALENDAR_LOOKS = ['list', 'week', 'month'] as const;
export type CalendarLook = (typeof CALENDAR_LOOKS)[number];
export const isCalendarLook = (v: unknown): v is CalendarLook =>
  typeof v === 'string' && (CALENDAR_LOOKS as readonly string[]).includes(v);

/** A week is 7 days from Monday (the owner's OK of the design); a month shows 6 such weeks. */
export const WEEK_DAYS = 7;
export const MONTH_DAYS = 42;

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
] as const;
const short = (m: string) => m.slice(0, 3);

/** The Monday on or before a day. */
export function weekStartOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** The first of a day's month. */
export function monthOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The month after or before one (its first day). */
export function monthMoved(month: string, by: number): string {
  const p = parseLocalDate(month);
  const at = new Date(Date.UTC(p.year, p.month - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

/** The first day a month's grid shows: the Monday on or before its first. */
export const monthGridFrom = (month: string): string => weekStartOf(monthOf(month));

/** The days from one, in order. */
export function daysFrom(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

/** The first day each look shows and how many days, for a day in it. */
export function lookRange(
  look: CalendarLook,
  day: string,
  today: string,
): { from: string; days: number } {
  if (look === 'week') return { from: weekStartOf(day), days: WEEK_DAYS };
  if (look === 'month') return { from: monthGridFrom(day), days: MONTH_DAYS };
  // Today and the two weeks after it.
  return { from: today, days: 15 };
}

/** "November 2026". */
export function monthShown(month: string): string {
  const p = parseLocalDate(month);
  return `${MONTHS[p.month - 1]} ${p.year}`;
}

/** "November". */
export const monthName = (month: string): string => MONTHS[parseLocalDate(month).month - 1]!;

/** "Nov 9 – 15, 2026", "Nov 30 – Dec 6, 2026", "Dec 28, 2026 – Jan 3, 2027". */
export function weekShown(from: string): string {
  const a = parseLocalDate(from);
  const b = parseLocalDate(addDays(from, WEEK_DAYS - 1));
  const am = short(MONTHS[a.month - 1]!);
  const bm = short(MONTHS[b.month - 1]!);
  if (a.year !== b.year) return `${am} ${a.day}, ${a.year} – ${bm} ${b.day}, ${b.year}`;
  return a.month === b.month
    ? `${am} ${a.day} – ${b.day}, ${b.year}`
    : `${am} ${a.day} – ${bm} ${b.day}, ${b.year}`;
}

/** "Nov 9 – 15": a week's days without the year, for the bar. */
export function weekShownShort(from: string): string {
  return weekShown(from).replace(/, \d{4}/g, '');
}

/** The filters above the Calendar: everything, or one kind. */
export const SHOW_FILTERS = ['all', 'waiting', 'okd', 'posted', 'failed', 'hidden'] as const;
export type ShowFilter = (typeof SHOW_FILTERS)[number];

/** What the Calendar needs to know about a post to show and pick it. */
export interface PickedLike {
  readonly id: string;
  readonly state: ContentState;
  readonly network: string;
  readonly hidden: boolean;
}

/**
 * Whether a post shows under a filter. Hidden ones show only under Hidden; All is everything else, skipped ones
 * included, as today's list shows them.
 */
export function shows(p: Pick<PickedLike, 'state' | 'hidden'>, filter: ShowFilter): boolean {
  if (filter === 'hidden') return p.hidden;
  if (p.hidden) return false;
  switch (filter) {
    case 'all':
      return true;
    case 'waiting':
      return p.state === 'draft';
    case 'okd':
      return p.state === 'ready' || p.state === 'posting';
    case 'posted':
      return p.state === 'posted';
    case 'failed':
      return p.state === 'failed';
  }
}

/** How many posts each filter shows. */
export function filterCounts(
  posts: readonly Pick<PickedLike, 'state' | 'hidden'>[],
): Record<ShowFilter, number> {
  const out = Object.fromEntries(SHOW_FILTERS.map((f) => [f, 0])) as Record<ShowFilter, number>;
  for (const p of posts) for (const f of SHOW_FILTERS) if (shows(p, f)) out[f]++;
  return out;
}

/**
 * The Pick menu's "all" picks (socialcontent.content.pick reads the same): everything, waiting for an OK, OK'd, past
 * (went up or didn't), didn't post, or hidden. Only everything and hidden take in hidden posts.
 */
export const PICK_WHICH = ['all', 'waiting', 'okd', 'past', 'failed', 'hidden'] as const;
export type PickWhich = (typeof PICK_WHICH)[number];

export function picks(p: Pick<PickedLike, 'state' | 'hidden'>, which: PickWhich): boolean {
  if (which === 'all') return true;
  if (which === 'hidden') return p.hidden;
  if (p.hidden) return false;
  switch (which) {
    case 'waiting':
      return p.state === 'draft';
    case 'okd':
      return p.state === 'ready';
    case 'failed':
      return p.state === 'failed';
    case 'past':
      return p.state === 'posted' || p.state === 'failed';
  }
}

/** What the picked posts are, and which of them each button acts on. */
export interface PickedSummary {
  readonly picked: number;
  readonly waiting: number;
  readonly okd: number;
  /** Posted or didn't post. */
  readonly past: number;
  readonly failed: number;
  readonly hidden: number;
  /** OK: those waiting for an OK. */
  readonly ok: readonly string[];
  /** Redo: those that went up or didn't. */
  readonly redo: readonly string[];
  /** Check if posted and Mark posted: those that didn't post. */
  readonly look: readonly string[];
  /** Hide: those not hidden yet. Show again: those hidden. */
  readonly hide: readonly string[];
  readonly show: readonly string[];
  /** Delete: all but one going up right now. */
  readonly remove: readonly string[];
}

export function summaryOf(posts: readonly PickedLike[]): PickedSummary {
  const ids = (keep: (p: PickedLike) => boolean) => posts.filter(keep).map((p) => p.id);
  const past = (p: PickedLike) => p.state === 'posted' || p.state === 'failed';
  return {
    picked: posts.length,
    waiting: posts.filter((p) => p.state === 'draft').length,
    okd: posts.filter((p) => p.state === 'ready').length,
    past: posts.filter(past).length,
    failed: posts.filter((p) => p.state === 'failed').length,
    hidden: posts.filter((p) => p.hidden).length,
    ok: ids((p) => p.state === 'draft'),
    redo: ids((p) => canRedo(p)),
    look: ids((p) => canLook(p)),
    hide: ids((p) => !p.hidden && p.state !== 'posting'),
    show: ids((p) => p.hidden),
    remove: ids((p) => p.state !== 'posting'),
  };
}

/** Picked posts are sent this many at a time, so any number can be picked. */
export function inTurns<T>(list: readonly T[], size: number = PICKING.most): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
