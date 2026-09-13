import { localDateOf, zoneOffsetMinutes } from '@hfos/core/server';

/**
 * Appointment times as people say them, in the calendar's time zone ("Fri, Sep 18, 10:00–11:00 AM", "Central
 * Time"), and as the model writes them (with the zone's offset). Pure, so the context and the tools share it.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const id = `${timeZone}|${key}`;
  let f = formatters.get(id);
  if (!f) formatters.set(id, (f = new Intl.DateTimeFormat('en-US', { timeZone, ...opts })));
  return f;
}
/** ICU puts a narrow no-break space before AM and PM; the cards and the model get a plain one. */
const plain = (s: string) => s.replace(/\s/g, ' ');

/** "Central Time". */
export function zoneLabel(timeZone: string, at: number = Date.now()): string {
  const part = fmt(timeZone, 'zone', { timeZoneName: 'longGeneric' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

/** "Thu, Sep 24". */
export const dayLabel = (at: number, timeZone: string): string =>
  plain(fmt(timeZone, 'day', { weekday: 'short', month: 'short', day: 'numeric' }).format(at));

/** "Thursday, September 24". */
export const longDayLabel = (at: number, timeZone: string): string =>
  plain(fmt(timeZone, 'long', { weekday: 'long', month: 'long', day: 'numeric' }).format(at));

/** "10:00 AM". */
export const clockLabel = (at: number, timeZone: string): string =>
  plain(fmt(timeZone, 'clock', { hour: 'numeric', minute: '2-digit' }).format(at));

/** "10:00–11:00 AM", "11:30 AM–12:30 PM". */
export function clockRange(start: number, end: number, timeZone: string): string {
  const a = clockLabel(start, timeZone);
  const b = clockLabel(end, timeZone);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}

/** "Fri, Sep 18, 10:00–11:00 AM" (the end's day too when it runs past midnight). */
export function rangeLabel(start: number, end: number, timeZone: string): string {
  if (localDateOf(start, timeZone) === localDateOf(end, timeZone))
    return `${dayLabel(start, timeZone)}, ${clockRange(start, end, timeZone)}`;
  return `${dayLabel(start, timeZone)}, ${clockLabel(start, timeZone)}–${dayLabel(end, timeZone)}, ${clockLabel(end, timeZone)}`;
}

/** "Fri, Sep 18 at 10:00 AM". */
export const atLabel = (at: number, timeZone: string): string =>
  `${dayLabel(at, timeZone)} at ${clockLabel(at, timeZone)}`;

/** 2026-09-24T08:00:00-05:00: an instant with the zone's offset, as the model reads and writes times. */
export function isoWithOffset(at: number, timeZone: string): string {
  const offset = zoneOffsetMinutes(at, timeZone);
  const local = new Date(Math.floor(at / 60_000) * 60_000 + offset * 60_000)
    .toISOString()
    .slice(0, 19);
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${offset < 0 ? '-' : '+'}${hh}:${mm}`;
}

/** "16:00" → "4 PM", "16:30" → "4:30 PM". */
export function hourLabel(clock: string): string {
  const [h = 0, m = 0] = clock.split(':').map(Number);
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
}

export const firstName = (full: string): string => full.trim().split(/\s+/)[0] || full;

/** "Priya", "Priya and Marco", "Dale, Priya and Marco". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
