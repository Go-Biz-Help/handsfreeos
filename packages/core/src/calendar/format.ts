/** Short plain-English wording shared by rules, diffs and impact messages. */
import { formatClock } from '../messaging/quiet-hours';
import type { WeeklyHours } from './config';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** 45 → "45 minutes", 90 → "90 minutes", 240 → "4 hours", 150 → "2 hours 30 minutes". */
export function formatDuration(minutes: number): string {
  if (minutes % 60 === 0 && minutes > 0) return plural(minutes / 60, 'hour', 'hours');
  if (minutes < 120) return plural(minutes, 'minute', 'minutes');
  return `${plural(Math.floor(minutes / 60), 'hour', 'hours')} ${plural(minutes % 60, 'minute', 'minutes')}`;
}

/** Notice: 240 → "4 hours", 1440 → "1 day", 2880 → "2 days", 0 → "none". */
export function formatNotice(minutes: number): string {
  if (minutes === 0) return 'none';
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day', 'days');
  return formatDuration(minutes);
}

export function countOf(n: number, one: string, many: string): string {
  return plural(n, one, many);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Mon–Fri 9:00 AM–5:00 PM, Sat 9:00 AM–12:00 PM". */
export function formatHours(hours: WeeklyHours | null): string {
  if (!hours) return 'none';
  if (!hours.length) return 'closed';
  const byDay = DAY_NAMES.map((_, day) =>
    hours
      .filter((h) => h.day === day)
      .sort((a, b) => a.start.localeCompare(b.start))
      .map((h) => `${formatClock(h.start)}–${h.end === '24:00' ? 'midnight' : formatClock(h.end)}`)
      .join(', '),
  );
  const groups: { from: number; to: number; text: string }[] = [];
  byDay.forEach((text, day) => {
    const last = groups[groups.length - 1];
    if (!text) return;
    if (last && last.text === text && last.to === day - 1) last.to = day;
    else groups.push({ from: day, to: day, text });
  });
  return groups
    .map((g) => `${DAY_NAMES[g.from]}${g.to > g.from ? `–${DAY_NAMES[g.to]}` : ''} ${g.text}`)
    .join('; ');
}
