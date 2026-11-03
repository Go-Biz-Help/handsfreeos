/**
 * The Time zone pick beside a time being set: Book, Reschedule, a webinar, and the phone's New appointment. Someone
 * books "2 PM Pacific" for a customer in Los Angeles without doing the math: the time is read on the picked zone's
 * clock and booked at that moment. The calendar itself keeps showing the business's zone (`when.ts`), so the line
 * beside the pick says where the time lands there: "That’s 4:00 PM Central Time on your calendar."
 *
 * Changing the zone keeps the clock as typed, as a paper diary would: 2:00 PM stays 2:00 PM, now on Pacific's clock.
 * The line beside the pick always shows the moment it books. Browser-safe.
 */
import { canonicalTimeZone } from '../intl/time-zones';
import { US_TIME_ZONES } from '../onboarding-setup/address';
import { localDateOf } from './engine/zoned';
import { fmtAt, fmtTime, weekdayShort, zoneLabel } from './when';

export interface ZoneChoice {
  readonly id: string;
  readonly label: string;
}

const ms = (at: number | string) => (typeof at === 'number' ? at : Date.parse(at));

/** The same zone, by its stored name ("US/Pacific" is "America/Los_Angeles"). */
export function sameZone(a: string, b: string): boolean {
  return a === b || (canonicalTimeZone(a) ?? a) === (canonicalTimeZone(b) ?? b);
}

/**
 * How a pick names a zone: "Central Time", "Arizona Time" (which Intl calls Mountain Time, like Denver); a zone off
 * the US list by its own name and city, "Philippine Standard Time (Manila)".
 */
export function zonePickLabel(zone: string): string {
  const id = canonicalTimeZone(zone) ?? zone;
  const us = US_TIME_ZONES.find((z) => z.id === id);
  if (us) return `${us.label} Time`;
  const label = zoneLabel(id);
  const city = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1).replace(/_/g, ' ') : '';
  return city && !label.includes(city) ? `${label} (${city})` : label;
}

/**
 * The zones a time can be set in, as a pick lists them: the US zones, east to west, with the calendar's own zone
 * and the one picked put first when they aren't among them.
 */
export function zoneChoices(calendarZone: string, picked?: string | null): readonly ZoneChoice[] {
  const us = US_TIME_ZONES.map((z) => z.id as string);
  const extra = [calendarZone, ...(picked ? [picked] : [])]
    .map((z) => canonicalTimeZone(z) ?? z)
    .filter((z) => !us.includes(z));
  return [...new Set([...extra, ...us])].map((id) => ({ id, label: zonePickLabel(id) }));
}

/**
 * The line beside a pick set to another zone: where the time lands on the calendar. "That’s 4:00 PM Central Time on
 * your calendar.", with the weekday when the day differs there: "That’s Tue 7:00 PM Central Time on your calendar."
 * Null when the pick is the calendar's own zone.
 */
export function zoneNote(at: number | string, picked: string, calendarZone: string): string | null {
  if (sameZone(picked, calendarZone)) return null;
  const t = ms(at);
  const here = localDateOf(t, calendarZone);
  const clock =
    here === localDateOf(t, picked)
      ? fmtTime(t, calendarZone)
      : `${weekdayShort(here)} ${fmtTime(t, calendarZone)}`;
  return `That’s ${clock} ${zonePickLabel(calendarZone)} on your calendar.`;
}

/**
 * When it was booked for, as the calendar's toasts say it: "Fri, Sep 18 at 4:00 PM", with the picked zone's clock
 * when it was set on another one: "Fri, Sep 18 at 4:00 PM (2:00 PM Pacific Time)".
 */
export function fmtAtPicked(at: number | string, picked: string, calendarZone: string): string {
  const base = fmtAt(at, calendarZone);
  if (sameZone(picked, calendarZone)) return base;
  const t = ms(at);
  const there = localDateOf(t, picked);
  const clock =
    there === localDateOf(t, calendarZone)
      ? fmtTime(t, picked)
      : `${weekdayShort(there)} ${fmtTime(t, picked)}`;
  return `${base} (${clock} ${zonePickLabel(picked)})`;
}
