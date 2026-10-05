/**
 * Facebook's times, made to last. A chat says "Today at 10:12 AM", "Yesterday", "Wed 11:02 AM" or just "10:12 AM",
 * which mean something else by the time anyone reads them in HandsFreeOS, so a saved message gets the day itself, the
 * way Facebook writes older ones: "Oct 5, 2026, 10:12 AM". Worked out on the person's own computer, whose calendar
 * Facebook printed them by. Anything else ("3h", "Sep 25, 2026, 11:39 PM") is kept as it was printed.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const CLOCK = '(\\d{1,2}:\\d{2}(?:\\s?[ap]\\.?m\\.?)?)';
const AT = `(?:,?\\s(?:at\\s)?${CLOCK})?`;
const DAY_WORD = new RegExp(`^(today|yesterday)${AT}$`, 'i');
const WEEKDAY = new RegExp(`^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\\.?${AT}$`, 'i');
const CLOCK_ONLY = new RegExp(`^${CLOCK}$`, 'i');
/** "Sep 28", "September 28 at 4:05 PM": a day this year, or last year's when this year's hasn't come yet. */
const MONTH_DAY = new RegExp(`^([a-z]{3})[a-z]*\\.?\\s(\\d{1,2})${AT}$`, 'i');
/** "28 September", the other way round. */
const DAY_MONTH = new RegExp(`^(\\d{1,2})\\s([a-z]{3})[a-z]*\\.?${AT}$`, 'i');

function day(now: Date, back: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
}

function written(date: Date, clock: string | undefined): string {
  const words = `${NAMES[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  return clock ? `${words}, ${clock}` : words;
}

/** A month and day with no year: this year's, unless that's still to come. */
function lastOn(now: Date, month: number, date: number): Date | null {
  if (month < 0 || date < 1 || date > 31) return null;
  const thisYear = new Date(now.getFullYear(), month, date);
  if (thisYear.getMonth() !== month) return null;
  return thisYear > day(now, 0) ? new Date(now.getFullYear() - 1, month, date) : thisYear;
}

/** A time as Facebook printed it, with the day spelled out when it only made sense on the day it was read. */
export function resolveWhen(when: string, now: Date): string {
  const text = when.replace(/\s+/g, ' ').trim();
  let m = DAY_WORD.exec(text);
  if (m) return written(day(now, m[1]!.toLowerCase() === 'today' ? 0 : 1), m[2]);
  m = CLOCK_ONLY.exec(text);
  if (m) return written(day(now, 0), m[1]);
  m = WEEKDAY.exec(text);
  if (m) {
    // Facebook names the weekday for the past week; today is only a time. So the last one before today.
    const back = (now.getDay() - WEEKDAYS.indexOf(m[1]!.toLowerCase()) + 7) % 7 || 7;
    return written(day(now, back), m[2]);
  }
  m = MONTH_DAY.exec(text);
  if (m) {
    const date = lastOn(now, MONTHS.indexOf(m[1]!.toLowerCase()), Number(m[2]));
    return date ? written(date, m[3]) : text;
  }
  m = DAY_MONTH.exec(text);
  if (m) {
    const date = lastOn(now, MONTHS.indexOf(m[2]!.toLowerCase()), Number(m[1]));
    return date ? written(date, m[3]) : text;
  }
  return text;
}
