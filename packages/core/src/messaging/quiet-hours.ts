/** Quiet hours in the workspace's time zone. Browser-safe: the composer shows the same answer the server enforces. */
import { addDays, localDateOf, localInstant } from '../calendar/engine/zoned';
import { intlTimeZone } from '../intl/engine-zones';

export interface QuietHoursWindow {
  readonly enabled: boolean;
  /** Local start, HH:MM (24 h). A start after the end wraps past midnight (20:00 to 08:00). */
  readonly start: string;
  readonly end: string;
}

export interface QuietHoursState {
  readonly quiet: boolean;
  /** The local time it is right now, HH:MM. */
  readonly localTime: string;
  /** When quiet hours end, HH:MM, while they are on. */
  readonly endsAt: string | null;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};
const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Minutes past local midnight in a time zone. */
export function localMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: intlTimeZone(timeZone),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

export function quietHoursState(
  window: QuietHoursWindow,
  timeZone: string,
  now: Date = new Date(),
): QuietHoursState {
  const local = localMinutes(now, timeZone);
  const localTime = hhmm(local);
  if (!window.enabled) return { quiet: false, localTime, endsAt: null };
  const s = minutesOf(window.start);
  const e = minutesOf(window.end);
  const quiet = s === e ? false : s < e ? local >= s && local < e : local >= s || local < e;
  return { quiet, localTime, endsAt: quiet ? window.end : null };
}

/** When quiet hours end, as an instant, or null when it isn't quiet hours at `now`. */
export function quietHoursEndAt(
  window: QuietHoursWindow,
  timeZone: string,
  now: Date = new Date(),
): Date | null {
  const q = quietHoursState(window, timeZone, now);
  if (!q.quiet || !q.endsAt) return null;
  const at = now.getTime();
  const today = localDateOf(at, timeZone);
  const end = localInstant(today, q.endsAt, timeZone);
  return new Date(end > at ? end : localInstant(addDays(today, 1), q.endsAt, timeZone));
}

/**
 * A text held until quiet hours end ("Send at 8:00 AM", message.send with sendAfterQuietHours): it stays queued,
 * `error_code` holds this note, and `occurred_at` is when it goes. The worker sends it then, after every check a text
 * passes; until then it can be cancelled, and the note turns to CANCELLED_TEXT (it never goes, and leaves the
 * conversation).
 */
export const SCHEDULED_TEXT = 'scheduled';
export const CANCELLED_TEXT = 'cancelled';

/** When a held text goes, or null for any other message (as synced, or as the API returns it). */
export function scheduledForOf(m: {
  readonly status: string;
  readonly errorCode: string | null;
  readonly occurredAt: string | Date;
}): string | null {
  if (m.status !== 'queued' || m.errorCode !== SCHEDULED_TEXT) return null;
  return new Date(m.occurredAt).toISOString();
}

/**
 * During quiet hours the AI teammate may still text a direct reply to a customer's own text, for this long
 * after it arrived, and at most QUIET_REPLY_LIMIT times in one conversation per quiet period. It never starts
 * a conversation in quiet hours. Email and website chat have no quiet hours.
 */
export const QUIET_REPLY_WINDOW_MS = 15 * 60_000;
export const QUIET_REPLY_LIMIT = 3;
/**
 * The one first message it may start in quiet hours (Automations, "New lead greeting"): to a lead who came in on
 * their own (a form, a text, a call) this long ago at most. A lead someone typed in, or an older one, waits for
 * the morning.
 */
export const QUIET_FIRST_MESSAGE_WINDOW_MS = 15 * 60_000;

/** When the quiet period `now` falls in began, or null when it isn't quiet hours. */
export function quietPeriodStart(
  window: QuietHoursWindow,
  timeZone: string,
  now: Date = new Date(),
): Date | null {
  if (!quietHoursState(window, timeZone, now).quiet) return null;
  const since = (localMinutes(now, timeZone) - minutesOf(window.start) + 1440) % 1440;
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  return new Date(minute - since * 60_000);
}

/** 20:00 becomes 8:00 PM. */
export function formatClock(value: string): string {
  const total = minutesOf(value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
