/**
 * The CRM screens' small formatters, in one place for the web and the phone (M10 step 15): dates, months, days,
 * sizes, addresses and the `tel:` link. Browser-safe.
 *
 * They were `apps/web/src/lib/format.ts`, which the record page, the pipeline, tasks, files and the timeline all
 * read. The dates are written out by hand in US English rather than handed to `Intl`, for the reason the inbox's
 * `inbox/time.ts` gives: Hermes on a phone and a browser's ICU disagree about the space before AM and about a few
 * abbreviations, and the two apps must say exactly the same thing. Everything reads the moment as the device does
 * (its own clock and zone), which is what the web has always done here.
 */

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

const DAY_MS = 86_400_000;

const clock = (d: Date): string => {
  const hours = d.getHours();
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour}:${String(d.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
};

/** "Sep 21", "Sep 21, 2025" in another year, and "Sep 21, 10:00 AM" with `time`. Nothing for no date. */
export function formatDate(
  iso: string | null | undefined,
  opts: { time?: boolean } = {},
  now: Date = new Date(),
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = `${MONTHS_SHORT[d.getMonth()]!} ${d.getDate()}`;
  const withYear = d.getFullYear() === now.getFullYear() ? date : `${date}, ${d.getFullYear()}`;
  return opts.time ? `${withYear}, ${clock(d)}` : withYear;
}

/**
 * "Oct 1, 2027": a moment's date in UTC, always with its year. For a date read the same everywhere it is shown —
 * a renewal on a support ticket, in an email and on the card — rather than on one device's own clock.
 */
export function formatUtcDate(d: Date): string {
  return `${MONTHS_SHORT[d.getUTCMonth()]!} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** A date-only value ("2026-09-21") as "Sep 21", with the year when it isn't this one. */
export function formatDateOnly(
  dateOnly: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!dateOnly) return '';
  const [y, m, d] = dateOnly.split('-').map(Number);
  if (!y || !m || !d) return dateOnly;
  const date = `${MONTHS_SHORT[m - 1] ?? ''} ${d}`;
  return y === now.getFullYear() ? date : `${date}, ${y}`;
}

/** "Sep 2025", for "Customer since …". */
export function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${MONTHS_SHORT[d.getMonth()]!} ${d.getFullYear()}`;
}

/** "10:24 AM" on the device's own clock. */
export function timeOfDay(iso: string | number | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : clock(d);
}

/** Whole days since a moment, never negative. */
export function daysSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / DAY_MS));
}

/** How long something has been where it is: "today", "1 day", "5 days". */
export function daysLabel(iso: string, now = Date.now()): string {
  const d = daysSince(iso, now);
  if (d === 0) return 'today';
  if (d === 1) return '1 day';
  return `${d} days`;
}

/** "512 B", "6 KB", "2.4 MB". Nothing for no size, as the web has always shown. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function telHref(e164: string | null | undefined): string | null {
  return e164 ? `tel:${e164}` : null;
}

export function smsHref(e164: string | null | undefined): string | null {
  return e164 ? `sms:${e164}` : null;
}

export interface AddressParts {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}

/** "1410 Oak Hollow Dr, Houston, TX 77006", leaving out whatever is missing. */
export function addressLine(a: AddressParts): string {
  const street = [a.line1, a.line2].filter(Boolean).join(', ');
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  return [street, [cityState, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
