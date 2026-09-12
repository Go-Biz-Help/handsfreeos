/** Quiet hours in the workspace's time zone. Browser-safe: the composer shows the same answer the server enforces. */

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
    timeZone,
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

/** 20:00 becomes 8:00 PM. */
export function formatClock(value: string): string {
  const total = minutesOf(value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
