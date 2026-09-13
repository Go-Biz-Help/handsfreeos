/**
 * A one-event iCalendar file (RFC 5545) a customer adds to their own calendar: METHOD:PUBLISH, a UID that
 * stays the same for the booking, and a SEQUENCE that grows whenever the booking is saved again, so
 * calendar apps replace their copy instead of adding a second one.
 */

export interface IcsEvent {
  readonly uid: string;
  readonly sequence: number;
  readonly start: Date;
  readonly end: Date;
  readonly summary: string;
  readonly description?: string | null;
  readonly location?: string | null;
  readonly url?: string | null;
  readonly cancelled?: boolean;
}

/** 20260918T150000Z */
const utc = (d: Date): string =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

const text = (s: string): string =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets continue on the next line after one space, never inside a character. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length === 0 ? 75 : 74)) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

export function icsCalendar(e: IcsEvent, now: Date = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HandsFreeOS//Booking page//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `SEQUENCE:${e.sequence}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${text(e.summary)}`,
    ...(e.location ? [`LOCATION:${text(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${text(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []),
    `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** Minutes since 2026-01-01 at the latest save: it grows with every change and fits SEQUENCE's integer. */
export function icsSequence(...savedAt: readonly Date[]): number {
  const latest = Math.max(...savedAt.map((d) => d.getTime()));
  return Math.max(0, Math.floor((latest - Date.UTC(2026, 0, 1)) / 60_000));
}
