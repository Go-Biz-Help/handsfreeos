/**
 * Dates and times on the calendar screens, always in the workspace's time zone and never the browser's: a
 * teammate travelling in Los Angeles still sees the Chicago business's 9 AM at 9 AM, labelled Central Time.
 * Formatting is done by hand, so the server and the browser print exactly the same characters.
 *
 * It all lives in `@hfos/core` now (`calendar/when.ts`), so the phone app shows the same day at the same moment
 * (M10 step 16). This file is the web's names for it, unchanged: `clockLabel` and `dateOf` are core's
 * `clockOfMinutes` and `localDayOf`, which were renamed only because core already had a `clockLabel(at, timeZone)`
 * and a `dateOf` would have read as an instant.
 */
export {
  clockOfMinutes as clockLabel,
  dayTime,
  fmtAt,
  fmtDateLong,
  fmtDateShort,
  fmtLength,
  fmtMonthDay,
  fmtMonthYear,
  fmtRange,
  fmtTime,
  fmtWeekRange,
  fmtWhen,
  hourLabel,
  localDayOf as dateOf,
  minutesBetween,
  minutesPastMidnight as minutesOf,
  TIME_OPTIONS,
  timeOptionsWith,
  todayIn,
  weekdayShort,
  zoneLabel,
} from '@hfos/core';
