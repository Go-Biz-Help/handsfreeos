/**
 * The Time zone pick beside a time being set: Book, Reschedule, a webinar, and the phone's New appointment. Someone
 * books "2 PM Pacific" for a customer in Los Angeles without doing the math: the time is read on the picked zone's
 * clock and booked at that moment. The calendar itself keeps showing the business's zone (`when.ts`), so the line
 * beside the pick says where the time lands there: "That’s 4:00 PM Central Time on your calendar."
 *
 * Changing the zone keeps the clock as typed, as a paper diary would: 2:00 PM stays 2:00 PM, now on Pacific's clock.
 * The line beside the pick always shows the moment it books.
 *
 * Tasks, a lead's next action and Snooze until have the same pick, starting on the business's zone rather than the
 * device's (owner's pick 1a, 2026-11-03): their line says "for the business" instead of "on your calendar", and
 * `zonedInputValue` / `instantOfInput` read a date-and-time box on the picked zone's clock. Browser-safe.
 */
import { TIME_ZONES } from '../intl/time-zone-names';
import { canonicalTimeZone } from '../intl/time-zones';
import { timeZoneForAddress, US_TIME_ZONES } from '../onboarding-setup/address';
import {
  formatLocalDate,
  isClock,
  isLocalDate,
  localDateOf,
  localInstant,
  zonedParts,
} from './engine/zoned';
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

/** A zone's place: "Manila" for Asia/Manila, "Knox, Indiana" for America/Indiana/Knox; nothing for UTC. */
function placeOf(id: string): string {
  const parts = id
    .split('/')
    .slice(1)
    .map((p) => p.replace(/_/g, ' '));
  return parts.length ? [parts.at(-1), ...parts.slice(0, -1).reverse()].join(', ') : '';
}

/**
 * How a pick names a zone: "Central Time", "Arizona Time" (which Intl calls Mountain Time, like Denver); a zone off
 * the US list by its own name and place, "Philippine Standard Time (Manila)".
 */
export function zonePickLabel(zone: string): string {
  const id = canonicalTimeZone(zone) ?? zone;
  const us = US_TIME_ZONES.find((z) => z.id === id);
  if (us) return `${us.label} Time`;
  if (id === 'UTC') return 'UTC';
  const label = zoneLabel(id);
  const place = placeOf(id);
  return place && !label.includes(place) ? `${label} (${place})` : label;
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

let more: readonly ZoneChoice[] | undefined;

/**
 * Every other zone HandsFreeOS knows, for "More time zones" under the US ones: place first, so a long list reads by
 * city, "Manila (Philippine Standard Time)", in alphabetical order, with UTC last. Worked out once.
 */
export function moreZoneChoices(): readonly ZoneChoice[] {
  if (!more) {
    const us = new Set<string>(US_TIME_ZONES.map((z) => z.id));
    more = TIME_ZONES.filter((id) => !us.has(id) && id !== 'UTC')
      .map((id) => ({ id, label: `${placeOf(id)} (${zoneLabel(id)})` }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en'))
      .concat({ id: 'UTC', label: 'UTC' });
  }
  return more;
}

/**
 * Zones matching what someone typed, for the phone's search under its zone chips: by place or name, "manila",
 * "london", "india", "eastern". The US zones come first.
 */
export function findZones(query: string, limit = 8): readonly ZoneChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const us = US_TIME_ZONES.map((z) => ({
    id: z.id as string,
    label: zonePickLabel(z.id),
    also: `${z.label} ${z.example}`,
  }));
  return [...us, ...moreZoneChoices().map((z) => ({ ...z, also: z.id }))]
    .filter((z) => `${z.label} ${z.also}`.toLowerCase().includes(q))
    .slice(0, limit)
    .map(({ id, label }) => ({ id, label }));
}

/**
 * The line beside a pick set to another zone: where the time lands on the calendar. "That’s 4:00 PM Central Time on
 * your calendar.", with the weekday when the day differs there: "That’s Tue 7:00 PM Central Time on your calendar."
 * Null when the pick is the calendar's own zone.
 */
export function zoneNote(
  at: number | string,
  picked: string,
  calendarZone: string,
  /** Where the time lands: "on your calendar", or "for the business" beside a task's or a follow-up's time. */
  where = 'on your calendar',
): string | null {
  if (sameZone(picked, calendarZone)) return null;
  const t = ms(at);
  const here = localDateOf(t, calendarZone);
  const clock =
    here === localDateOf(t, picked)
      ? fmtTime(t, calendarZone)
      : `${weekdayShort(here)} ${fmtTime(t, calendarZone)}`;
  return `That’s ${clock} ${zonePickLabel(calendarZone)} ${where}.`;
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

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A moment as a date-and-time box's value on a zone's clock, "2026-11-10T14:00", or its date alone with `dateOnly`,
 * "2026-11-10": what the box shows for a task's due time or a follow-up's when the pick is on that zone.
 */
export function zonedInputValue(
  at: number | string | Date,
  zone: string,
  dateOnly = false,
): string {
  const p = zonedParts(at instanceof Date ? at : ms(at), zone);
  const date = formatLocalDate(p.year, p.month, p.day);
  return dateOnly ? date : `${date}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * A date-and-time box's value ("2026-11-10T14:00", seconds allowed) read on a zone's clock, as the moment it is. A
 * date alone ("2026-11-10") is noon there, the moment an all-day task is kept at, so its day is the same day across
 * the US. Null when the box doesn't hold a date.
 */
export function instantOfInput(value: string, zone: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(value.trim());
  const date = m?.[1];
  const clock = m?.[2] ?? '12:00';
  if (!date || !isLocalDate(date) || !isClock(clock)) return null;
  return localInstant(date, clock, zone);
}

/**
 * The zone a customer's texts, emails, reminders and pages tell a time in. The owner's answer (2026-11-03): "the
 * timezone should try to always show in the viewer's timezone but if it doesn't know it it defaults to the one set by
 * the business". So: the zone they booked in (the booking page's, from their device) or the one their time was set in
 * for them (the Time zone pick); else the zone of their US address; else the calendar's (its own, or the business's).
 */
export function customerTimeZone(
  customer: {
    /** The appointment attendee's own zone (`appointment_attendees.timezone`), when one was kept. */
    readonly zone?: string | null;
    readonly state?: string | null;
    readonly postalCode?: string | null;
    readonly country?: string | null;
  },
  calendarZone: string,
): string {
  const own = customer.zone ? canonicalTimeZone(customer.zone) : null;
  if (own) return own;
  if (customer.state && (customer.country ?? 'US').toUpperCase() === 'US') {
    const there = timeZoneForAddress({ state: customer.state, postalCode: customer.postalCode });
    if (there) return there;
  }
  return calendarZone;
}

/** The zone to keep on an attendee for a time set on `picked`'s clock: nothing when that's the calendar's own. */
export const attendeeZoneOf = (
  picked: string | null | undefined,
  calendarZone: string,
): string | null =>
  picked && !sameZone(picked, calendarZone) ? (canonicalTimeZone(picked) ?? picked) : null;
