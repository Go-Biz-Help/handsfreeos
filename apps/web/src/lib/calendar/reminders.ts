/**
 * How a booking's confirmation and reminders read on screen: their names, why one was skipped or went by
 * email instead of text, when the calendar sends them, and the line under Tell saying what a customer will
 * get. Keys and reasons are the worker's, as it records them on each attendee (reminder_state).
 *
 * It lives in `@hfos/core` now (`calendar/reminder-words.ts`), so the phone's appointment sheet says the same
 * (M10 step 16). `reminderSchedule` is core's `reminderScheduleWords`, renamed only because core's money settings
 * already had a `reminderSchedule` (the chasing steps on an unpaid invoice).
 */
export {
  byLead,
  reminderKeyOf,
  reminderLabel,
  reminderNoun,
  reminderScheduleWords as reminderSchedule,
  reminderWhy,
  tellNote,
  type TellFacts,
} from '@hfos/core';
