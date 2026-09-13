/**
 * Appointment reminders: what each is called, when it is due for a start, when one would only crowd the
 * confirmation because the booking came late, and the attendee's reminder_state as the worker records it.
 * Pure and browser-safe.
 */
import { ReminderEntry, type ReminderState } from '../schemas/calendar';
import type { Reminder } from './config';
import { addDays, localDateOf, localInstant } from './engine/zoned';

const MIN = 60_000;
const HOUR = 3_600_000;

/** How a reminder is named in reminder_state and its job's key: 'day_before', or 'before_120'. */
export function reminderKey(reminder: Reminder): string {
  return reminder.kind === 'day_before' ? 'day_before' : `before_${reminder.minutes}`;
}

/** When a reminder goes: the day before the start's local date at its clock time, or so many minutes ahead. */
export function reminderDueAt(reminder: Reminder, startsAt: number, timeZone: string): number {
  if (reminder.kind === 'before') return startsAt - reminder.minutes * MIN;
  return localInstant(addDays(localDateOf(startsAt, timeZone), -1), reminder.at, timeZone);
}

/**
 * Whether a reminder would only crowd the confirmation: the day-before one when the booking came less than 18
 * hours ahead, a minutes-before one when it came less than an hour more than that ahead (3 hours for the
 * 2-hour one).
 */
export function bookedTooLate(reminder: Reminder, startsAt: number, bookedAt: number): boolean {
  const needed = reminder.kind === 'day_before' ? 18 * HOUR : (reminder.minutes + 60) * MIN;
  return startsAt - bookedAt < needed;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function entryOf(value: unknown): ReminderEntry | null {
  const parsed = ReminderEntry.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The stored jsonb read as the schema says; anything that doesn't fit is left out (it never throws). */
export function parseReminderState(raw: unknown): ReminderState {
  const doc = isObject(raw) ? raw : {};
  const reminders: Record<string, ReminderEntry> = {};
  const stored = doc['reminders'];
  if (isObject(stored))
    for (const [key, value] of Object.entries(stored)) {
      const entry = entryOf(value);
      if (entry) reminders[key] = entry;
    }
  return { confirmation: entryOf(doc['confirmation']), reminders };
}
