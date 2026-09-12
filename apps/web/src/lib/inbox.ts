/** Inbox display helpers: waiting chips, list times, and snooze times in the business's time zone. */

export function minutesWaiting(since: string | null | undefined, now = Date.now()): number | null {
  if (!since) return null;
  return Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
}

/** "Waiting 12 min", "Waiting 2 h", "Waiting 3 d". */
export function waitingLabel(minutes: number): string {
  if (minutes < 60) return `Waiting ${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Waiting ${hours} h`;
  return `Waiting ${Math.floor(hours / 24)} d`;
}

/** The time on a conversation row: "10:24 AM" today, "Yesterday", "Tue" this week, "Sep 3" before that. */
export function listTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86_400_000)
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The divider between days in a thread: "Today", "Yesterday", "Monday" this week, "Wednesday, September 9". */
export function dayDivider(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - d.getTime() < 6 * 86_400_000)
    return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 is Sunday. */
  readonly weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** Minutes the zone is ahead of UTC at that instant. */
function zoneOffsetMinutes(at: number, timeZone: string): number {
  const p = zonedParts(new Date(at), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/** The instant a wall-clock time happens in a zone (settled twice so a daylight-saving change lands right). */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let at = wall - zoneOffsetMinutes(wall, timeZone) * 60_000;
  at = wall - zoneOffsetMinutes(at, timeZone) * 60_000;
  return new Date(at);
}

export interface SnoozeOption {
  readonly key: '1h' | '3h' | 'tomorrow' | 'next_week';
  readonly label: string;
  readonly until: Date;
  /** "3:10 PM" today, "Sat 8:00 AM" on another day, in the business's time zone. */
  readonly when: string;
}

/** A moment as the business sees it: "3:10 PM", or "Sat 8:00 AM" when it isn't today there. */
export function zonedWhen(at: Date, timeZone: string, now = new Date()): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(at);
  if (day(at) === day(now)) return time;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(at);
  return `${weekday} ${time}`;
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
