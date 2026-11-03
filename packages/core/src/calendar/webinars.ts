/**
 * Scheduling a webinar (webinar.schedule, docs/video-calls.md "Webinars"): one date, or the same time every week,
 * every 2 weeks or every month, on the business's webinar calendar, which is made the first time. What the web and the
 * phone show for it lives here once.
 */
import type { CalendarConfig } from './config';
import { MAX_OCCURRENCES } from './engine/recurrence';
import { parseLocalDate, weekdayOf } from './engine/zoned';

/**
 * A webinar calendar: fixed sessions on a HandsFreeOS video call, so each session runs as a webinar. The Webinar
 * preset makes one, and Settings → Calendars shows its Webinar settings.
 */
export const isWebinarCalendar = (config: CalendarConfig): boolean =>
  config.schedule.mode === 'sessions' &&
  config.locations.options.some((o) => o.kind === 'virtual' && o.video === 'handsfree');

/** What the calendar webinar.schedule makes, when the business has no webinar calendar yet, is called. */
export const WEBINAR_CALENDAR_NAME = 'Webinars';

export const WEBINAR_REPEATS = ['none', 'week', 'two_weeks', 'month'] as const;
export type WebinarRepeat = (typeof WEBINAR_REPEATS)[number];
export type WebinarRepeatEvery = Exclude<WebinarRepeat, 'none'>;

/** The most dates one repeat books: a year's worth, within the calendar engine's limit. */
export const webinarRepeatMax = (every: WebinarRepeatEvery): number =>
  Math.min(MAX_OCCURRENCES, every === 'week' ? 52 : every === 'two_weeks' ? 26 : 12);

/** How many dates a repeat books unless the person says: about three months' worth. */
export const webinarRepeatDefault = (every: WebinarRepeatEvery): number =>
  every === 'week' ? 12 : every === 'two_weeks' ? 6 : 3;

/** The repeat rule for a choice. A monthly one falls on the same weekday, like the 2nd Tuesday. */
export function webinarRepeatRule(every: WebinarRepeatEvery, count: number, localTime: string) {
  return {
    freq: every === 'month' ? ('monthly_nth' as const) : ('weekly' as const),
    interval: every === 'two_weeks' ? 2 : 1,
    count: Math.min(count, webinarRepeatMax(every)),
    localTime,
  };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NTH = ['1st', '2nd', '3rd', '4th', '5th'];

/** "Every week on Tuesday", "Every month on the 2nd Tuesday": a choice, for the first date. */
export function webinarRepeatLabel(every: WebinarRepeat, firstDate: string | null): string {
  if (every === 'none') return 'Doesn’t repeat';
  if (!firstDate)
    return { week: 'Every week', two_weeks: 'Every 2 weeks', month: 'Every month' }[every];
  const day = WEEKDAYS[weekdayOf(firstDate)]!;
  if (every === 'week') return `Every week on ${day}`;
  if (every === 'two_weeks') return `Every 2 weeks on ${day}`;
  const nth = Math.ceil(parseLocalDate(firstDate).day / 7);
  // A 5th weekday isn't in every month, and the months without one are skipped.
  return nth === 5
    ? `Every month on the 5th ${day}, when there is one`
    : `Every month on the ${NTH[nth - 1]} ${day}`;
}
