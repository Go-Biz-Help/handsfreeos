/**
 * When an event is, as a network's page writes it (docs/outreach.md decision 188): whether a line is one, the line in
 * everyday capitals, and the moment it starts, for Today's list of the events near the person. Facebook writes "THU,
 * DEC 4 AT 7:30 AM CST", "Thursday, December 4, 2025 at 7:30 AM – 9:00 AM", "Tomorrow at 6 PM" or "Happening now";
 * Alignable much the same. The page shows times in the person's own time zone, as their computer keeps it, so the
 * moment is read in that zone.
 */

const WEEKDAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?';
const MONTH =
  '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:uary|ruary|ch|il|e|y|ust|ember|ober|tember)?\\.?';
const TIME = '(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?\\s?m\\.?';

/** "Thu, Dec 4", "Thursday, December 4, 2025 at 7:30 AM", "Dec 4 – Dec 6". */
const ON_A_DAY = new RegExp(
  `^(?:(?:this\\s+)?${WEEKDAY},?\\s+)?${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?(?:,?\\s+(?:at|from|·)\\s+${TIME})?`,
  'i',
);
/** "Today at 7 PM", "Tomorrow", "Tonight at 6:30 PM". */
const SOON = new RegExp(`^(today|tomorrow|tonight)(?:\\s+(?:at|from)\\s+${TIME})?`, 'i');
/** "Saturday at 10 AM", "This Friday at 6 PM": in the week ahead. */
const THIS_WEEK = new RegExp(`^(?:this\\s+)?(${WEEKDAY})\\s+(?:at|from)\\s+${TIME}`, 'i');
const NOW = /^happening now\b/i;
/** "Every Tuesday", "Every other Thursday", "Every month": a repeating event, with no one day to start from. */
const EVERY = new RegExp(`^every\\s+(other\\s+)?(${WEEKDAY}|day|week|month|weekday)s?\\b`, 'i');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Whether a line on an event's page or card says when it is. */
export function isWhenLine(line: string): boolean {
  const text = line.trim();
  return (
    text.length > 0 &&
    text.length <= 120 &&
    (NOW.test(text) ||
      ON_A_DAY.test(text) ||
      SOON.test(text) ||
      THIS_WEEK.test(text) ||
      EVERY.test(text))
  );
}

/** The words that stay in capitals in a calmed line: AM and PM, and time zones (CST, PDT, AKST, UTC, GMT). */
const KEPT_CAPS = /^([AP]\.?M\.?|[A-Z]{2,3}T|UTC|GMT)$/;
const SMALL_WORDS = new Set(['at', 'from', 'to', 'until', 'and', 'this']);

/**
 * A line in everyday capitals when the page wrote it all in capitals, as Facebook writes an event's day: "THU, DEC 4
 * AT 7:30 AM CST" is "Thu, Dec 4 at 7:30 AM CST". Anything else stays as it was.
 */
export function calmCase(line: string): string {
  if (line !== line.toUpperCase() || !/[A-Z]/.test(line)) return line;
  return line
    .split(/(\s+)/)
    .map((word) => {
      const bare = word.replace(/[^A-Za-z.]/g, '');
      if (!bare) return word;
      const start = bare.toLowerCase().slice(0, 3);
      if (KEPT_CAPS.test(bare) && !MONTHS.includes(start) && !WEEKDAYS.includes(start)) return word;
      if (SMALL_WORDS.has(bare.toLowerCase())) return word.toLowerCase();
      const lower = word.toLowerCase();
      const first = lower.search(/[a-z]/);
      return first < 0
        ? lower
        : lower.slice(0, first) + lower[first]!.toUpperCase() + lower.slice(first + 1);
    })
    .join('');
}

const hours = (h: string | undefined, m: string | undefined, half: string | undefined) => {
  if (!h || !half) return null;
  const hour = (Number(h) % 12) + (half.toLowerCase() === 'p' ? 12 : 0);
  const minute = m ? Number(m) : 0;
  return hour < 24 && minute < 60 ? { hour, minute } : null;
};

/** A day with no time said: midday, to keep it on today's list till the day's out. Tonight: the evening. */
const NOON = { hour: 12, minute: 0 };
const EVENING = { hour: 18, minute: 0 };

const at = (day: Date, time: { hour: number; minute: number }) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hour, time.minute);

/**
 * When an event starts, read from its line, in the person's own time zone, or null when the line doesn't say a day.
 * A day without a year is the next one: this year's, or next year's when this year's went by two months ago.
 */
export function startsAtOf(line: string | null, now: Date = new Date()): string | null {
  const text = line?.trim() ?? '';
  if (!text) return null;
  if (NOW.test(text)) return now.toISOString();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const soon = SOON.exec(text);
  if (soon) {
    const word = soon[1]!.toLowerCase();
    const day = new Date(today);
    if (word === 'tomorrow') day.setDate(day.getDate() + 1);
    const time = hours(soon[2], soon[3], soon[4]) ?? (word === 'tonight' ? EVENING : NOON);
    return at(day, time).toISOString();
  }
  const week = THIS_WEEK.exec(text);
  if (week) {
    const want = WEEKDAYS.indexOf(week[1]!.toLowerCase().slice(0, 3));
    const time = hours(week[2], week[3], week[4]);
    if (want < 0 || !time) return null;
    const day = new Date(today);
    day.setDate(day.getDate() + ((want - day.getDay() + 7) % 7));
    return at(day, time).toISOString();
  }
  const on = ON_A_DAY.exec(text);
  if (!on) return null;
  const month = MONTHS.indexOf(on[1]!.toLowerCase().slice(0, 3));
  const date = Number(on[2]);
  if (month < 0 || date < 1 || date > 31) return null;
  const time = hours(on[4], on[5], on[6]) ?? NOON;
  let year = on[3] ? Number(on[3]) : now.getFullYear();
  let day = new Date(year, month, date);
  if (day.getMonth() !== month) return null;
  if (!on[3] && day.getTime() < today.getTime() - 60 * 86_400_000) {
    year += 1;
    day = new Date(year, month, date);
  }
  return at(day, time).toISOString();
}
