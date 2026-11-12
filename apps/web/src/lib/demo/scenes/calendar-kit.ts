import { businessOf, wallTime, type DemoWorld } from '../world';
import { clock, shortDay } from './kit';
import type { DemoPlayer } from './types';

/** Small pieces the money, paperwork and calendar scenes (31 to 38) share. */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/** A local date, `YYYY-MM-DD`, `days` from today where the business is. */
export const localDate = (at: number, days: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(wallTime(at, timeZone, days, 12)));

/** The last half hour before `ms`: a visit that ended a little while ago starts on one. */
export const halfHourBefore = (ms: number) => Math.floor(ms / (30 * MIN)) * 30 * MIN;

interface CalendarPathOptions {
  readonly view?: 'day' | 'week';
  readonly appt?: string;
}

function calendarOn(p: DemoPlayer, date: string, o: CalendarPathOptions): string {
  const q = new URLSearchParams({ view: o.view ?? 'day', date, people: p.me.id });
  if (o.appt) q.set('appt', o.appt);
  return `calendar?${q.toString()}`;
}

/**
 * The calendar on a day `days` from today, on the presenter's own column (Day) or their week, with a visit's sheet
 * open when `appt` is given.
 */
export const calendarPath = (p: DemoPlayer, days: number, o: CalendarPathOptions = {}): string =>
  calendarOn(p, localDate(Date.now(), days, p.timeZone), o);

/**
 * The calendar on the day the instant `at` falls on where the business is: the day of a visit the scene's setup
 * placed a little before the scene started (`halfHourBefore`), worked out from `p.startedAt`. Played in the first
 * hour or so after midnight, that visit was yesterday, and today's calendar (`calendarPath(p, 0)`) wouldn't show it.
 */
export const calendarPathAt = (p: DemoPlayer, at: number, o: CalendarPathOptions = {}): string =>
  calendarOn(p, localDate(at, 0, p.timeZone), o);

/** Opens a visit's sheet from the calendar, as a click on it would, and waits for it. */
export async function openVisit(p: DemoPlayer, visitId: string): Promise<void> {
  await p.click(`@appt-${visitId}`);
  await p.waitFor('@appointment-sheet', 15_000);
}

/** "CST", as the booking texts write the zone. */
export const shortZone = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(ms))
    .find((x) => x.type === 'timeZoneName')?.value ?? '';

/** The booking confirmation, as apps/worker/src/booking/messages.ts words it. */
export const bookedText = (w: DemoWorld, starts: number, title: string, link: string) => {
  const tz = w.state.timeZone;
  const time = clock(starts, tz).replace(/\u202f/g, ' ');
  return `${businessOf(w)}: You're booked for ${shortDay(starts, tz)} at ${time} ${shortZone(starts, tz)} (${title}). Change or cancel: ${link}`;
};

/** The default reminders every visit here sets: the confirmation now, then the day before and 2 hours before. */
export const REMINDERS = ['day_before', 'before_120'] as const;
