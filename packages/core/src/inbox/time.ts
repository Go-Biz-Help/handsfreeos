/**
 * The inbox's times, the same on the web and the phone (M10): how long a customer has waited, the time on a
 * conversation row, the divider between days in a thread, when a held text goes, and the snooze menu. Browser-safe.
 *
 * Rows and threads read the moment as the device does (the browser's or the phone's own clock and zone). The snooze
 * menu, "Snoozed until …" and when a held text goes read it where the business is: quiet hours end on the business's
 * clock, and the question before a held text says that time ("Send at 8:00 AM"), so the thread says the same. Each is written out by hand in US English, so
 * every engine (Chrome, Safari, Hermes on both phones) shows the same words with plain spaces.
 */
import { zonedParts, zonedTime } from '../calendar/engine/zoned';
import { formatClock } from '../messaging/quiet-hours';

const DAY_MS = 86_400_000;
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
const MONTHS_LONG = [
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

const two = (n: number) => String(n).padStart(2, '0');
const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

/** Whole minutes since a moment, never negative. */
export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}

/** Whole minutes someone has waited, or null when nobody is waiting. The chip's words are `waitingFor`. */
export function minutesWaiting(since: string | null | undefined, now = Date.now()): number | null {
  return since ? minutesSince(since, now) : null;
}

/**
 * How long something has waited: "just now" under a minute, then "waiting 1 min", "waiting 3 h", "waiting 2 d".
 * `short` leaves out "waiting" for a narrow column ("12 min"); `capital` starts a chip with a capital letter.
 */
export function waitingFor(
  minutes: number,
  opts: { short?: boolean; capital?: boolean } = {},
): string {
  const hours = Math.floor(minutes / 60);
  const span =
    minutes < 60 ? `${minutes} min` : hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
  const label = minutes < 1 ? 'just now' : opts.short ? span : `waiting ${span}`;
  return opts.capital ? label.charAt(0).toUpperCase() + label.slice(1) : label;
}

/** "10:24 AM", on the device's own clock. */
export function clockTime(iso: string | number | Date): string {
  const d = toDate(iso);
  return formatClock(`${two(d.getHours())}:${two(d.getMinutes())}`);
}

/** The time on a conversation row: "10:24 AM" today, "Yesterday", "Tue" this week, "Sep 3" before that. */
export function listTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return clockTime(d);
  const yesterday = new Date(now.getTime() - DAY_MS);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * DAY_MS) return WEEKDAYS_SHORT[d.getDay()]!;
  const date = `${MONTHS_SHORT[d.getMonth()]!} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** The divider between days in a thread: "Today", "Yesterday", "Monday" this week, "Wednesday, September 9". */
export function dayDivider(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now.getTime() - DAY_MS);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * DAY_MS) return WEEKDAYS_LONG[d.getDay()]!;
  const date = `${WEEKDAYS_LONG[d.getDay()]!}, ${MONTHS_LONG[d.getMonth()]!} ${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
}

/** The day a thread groups a moment under, on the device's clock. */
export function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

/** A time under an entry with its weekday, for a narrow sheet: "Tue 10:24 AM". */
export function weekdayClock(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAYS_SHORT[d.getDay()]!} ${clockTime(d)}`;
}

/**
 * When a held text goes, where the business is: "at 8:00 AM", "tomorrow at 8:00 AM", "Monday at 8:00 AM". A phone in
 * another zone says the same time the quiet-hours question offered.
 */
export function heldWhen(iso: string, timeZone: string, now = new Date()): string {
  const p = zonedParts(new Date(iso), timeZone);
  const n = zonedParts(now, timeZone);
  const time = formatClock(`${two(p.hour)}:${two(p.minute)}`);
  const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
  const days = Math.round((day(p.year, p.month, p.day) - day(n.year, n.month, n.day)) / DAY_MS);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${WEEKDAYS_LONG[p.weekday]!} at ${time}`;
}

/** A moment as the business sees it: "3:10 PM", or "Sat 8:00 AM" when it isn't today there. */
export function zonedWhen(at: Date, timeZone: string, now = new Date()): string {
  const p = zonedParts(at, timeZone);
  const n = zonedParts(now, timeZone);
  const time = formatClock(`${two(p.hour)}:${two(p.minute)}`);
  if (p.year === n.year && p.month === n.month && p.day === n.day) return time;
  return `${WEEKDAYS_SHORT[p.weekday]!} ${time}`;
}

/** The time of day a moment is where the business is: "8:00 AM". */
export function zonedClock(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return formatClock(`${two(p.hour)}:${two(p.minute)}`);
}

export interface SnoozeOption {
  readonly key: '1h' | '3h' | 'tomorrow' | 'next_week';
  readonly label: string;
  readonly until: Date;
  /** "3:10 PM" today, "Sat 8:00 AM" on another day, in the business's time zone. */
  readonly when: string;
}

/** The snooze menu: an hour, three hours, tomorrow at 8 AM, and next Monday at 8 AM, in the business's zone. */
export function snoozeOptions(timeZone: string, now = new Date()): SnoozeOption[] {
  const p = zonedParts(now, timeZone);
  const dayAfter = (days: number) => {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 8, 0, timeZone);
  };
  const toMonday = (8 - p.weekday) % 7 || 7;
  const options = [
    { key: '1h', label: 'In 1 hour', until: new Date(now.getTime() + 60 * 60_000) },
    { key: '3h', label: 'In 3 hours', until: new Date(now.getTime() + 3 * 60 * 60_000) },
    { key: 'tomorrow', label: 'Tomorrow morning', until: dayAfter(1) },
    { key: 'next_week', label: 'Next week', until: dayAfter(toMonday) },
  ] as const;
  return options.map((o) => ({ ...o, when: zonedWhen(o.until, timeZone, now) }));
}

/** A call's length as m:ss ("0:07", "4:12", "75:12"). */
export function callClock(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
