/**
 * Wall-clock time in an IANA time zone, with no date library. Browser-safe.
 *
 * Daylight saving, matching Postgres (`timestamp AT TIME ZONE`), so the builder, the engine and
 * `private.expand_schedule` agree:
 * - A wall time that never happens (spring forward, 2:30 AM on 2026-03-08 in America/Chicago) is read
 *   with the offset from before the change, so it lands an hour later on the clock: 3:30 AM CDT.
 * - A wall time that happens twice (fall back, 1:30 AM on 2026-11-01 in America/Chicago) is read with the
 *   offset from after the change: the second 1:30, in CST. `zonedInstants` returns both.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 is Sunday. */
  readonly weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in a zone at an instant. */
export function zonedParts(at: Date | number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(typeof at === 'number' ? at : at.getTime());
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = 0;
  for (const p of parts) {
    if (p.type === 'year') year = Number(p.value);
    else if (p.type === 'month') month = Number(p.value);
    else if (p.type === 'day') day = Number(p.value);
    else if (p.type === 'hour') hour = Number(p.value) % 24;
    else if (p.type === 'minute') minute = Number(p.value);
    else if (p.type === 'weekday') weekday = WEEKDAYS.indexOf(p.value);
  }
  return { year, month, day, hour, minute, weekday };
}

/** Minutes the zone is ahead of UTC at that instant (Chicago in summer: -300). */
export function zoneOffsetMinutes(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at / MINUTE) * MINUTE) / MINUTE);
}

/** The offsets in force a day before and a day after a wall time (equal unless a change is near). */
function offsetsAround(wall: number, timeZone: string): { before: number; after: number } {
  return {
    before: zoneOffsetMinutes(wall - DAY, timeZone),
    after: zoneOffsetMinutes(wall + DAY, timeZone),
  };
}

/**
 * Every instant a wall time happens, earliest first: none in a spring-forward gap, two in a
 * fall-back hour, otherwise one.
 */
export function zonedInstants(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number[] {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const { before, after } = offsetsAround(wall, timeZone);
  const out: number[] = [];
  for (const offset of before === after ? [before] : [before, after]) {
    const at = wall - offset * MINUTE;
    if (zoneOffsetMinutes(at, timeZone) === offset && !out.includes(at)) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/** The instant a wall-clock time happens in a zone, with the Postgres rule for gaps and repeats (see above). */
export function zonedEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const found = zonedInstants(year, month, day, hour, minute, timeZone);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) return found[found.length - 1]!;
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return wall - offsetsAround(wall, timeZone).before * MINUTE;
}

/** `zonedEpoch` as a Date (the web's inbox snooze times use this). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  return new Date(zonedEpoch(year, month, day, hour, minute, timeZone));
}

// ---- Local dates ('YYYY-MM-DD') and clock times ('HH:MM') ----

export interface LocalDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

export function isLocalDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return (
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
  );
}

export function isClock(value: string): boolean {
  return CLOCK_RE.test(value);
}

export function parseLocalDate(value: string): LocalDateParts {
  const m = DATE_RE.exec(value);
  if (!m) throw new RangeError(`Not a date: ${value}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function formatLocalDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Calendar arithmetic on a local date; `addDays('2026-03-07', 1)` is '2026-03-08' whatever the zone. */
export function addDays(date: string, days: number): string {
  const p = parseLocalDate(date);
  return formatLocalDate(p.year, p.month, p.day + days);
}

/** 0 is Sunday. */
export function weekdayOf(date: string): number {
  const p = parseLocalDate(date);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Whole days from one local date to another. */
export function daysBetween(from: string, to: string): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY,
  );
}

/** The local date in a zone at an instant. */
export function localDateOf(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  return formatLocalDate(p.year, p.month, p.day);
}

/** Minutes past midnight for 'HH:MM' ('24:00' is 1440). */
export function parseClock(value: string): number {
  if (!isClock(value)) throw new RangeError(`Not a time: ${value}`);
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

/** The instant a local date and clock time happen; '24:00' is the next day's midnight. */
export function localInstant(date: string, clock: string, timeZone: string): number {
  const minutes = parseClock(clock);
  const p = parseLocalDate(date);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + Math.floor(minutes / 1440)));
  return zonedEpoch(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    Math.floor((minutes % 1440) / 60),
    minutes % 60,
    timeZone,
  );
}

/** When a local day starts. */
export function startOfLocalDay(date: string, timeZone: string): number {
  return localInstant(date, '00:00', timeZone);
}
