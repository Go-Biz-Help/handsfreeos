/**
 * How a booking's confirmation and reminders read on screen: their names, why one was skipped or went by
 * email instead of text, when the calendar sends them, and the line under Tell saying what a customer will
 * get. Keys and reasons are the worker's, as it records them on each attendee (reminder_state).
 */
import { formatDuration, type CalendarConfig, type Reminder } from '@hfos/core';

type Notifications = CalendarConfig['notifications'];

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const andJoin = (list: readonly string[]) =>
  list.length <= 1
    ? (list[0] ?? '')
    : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;

/** A reminder's key in reminder_state, as the worker names it: 'day_before' or 'before_120'. */
export const reminderKeyOf = (r: Reminder): string =>
  r.kind === 'day_before' ? 'day_before' : `before_${r.minutes}`;

const minutesOf = (key: string): number | null => {
  const m = /^before_(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
};
const lead = (key: string) => (key === 'day_before' ? 1440 : (minutesOf(key) ?? 0));

/** Sorts reminder keys in the order they go out: the earliest first (the day-before one counts as a day). */
export const byLead = (a: string, b: string): number => lead(b) - lead(a);

/** "Confirmation", "Day before", "2 hours before": a row on the appointment sheet. */
export function reminderLabel(key: string): string {
  if (key === 'confirmation') return 'Confirmation';
  if (key === 'day_before') return 'Day before';
  const minutes = minutesOf(key);
  return minutes ? `${capital(formatDuration(minutes))} before` : 'Reminder';
}

/** "confirmation", "day-before reminder", "2-hour reminder": inside a sentence. */
export function reminderNoun(key: string): string {
  if (key === 'confirmation') return 'confirmation';
  if (key === 'day_before') return 'day-before reminder';
  const n = minutesOf(key);
  if (!n) return 'reminder';
  const span = n % 1440 === 0 ? `${n / 1440}-day` : n % 60 === 0 ? `${n / 60}-hour` : `${n}-minute`;
  return `${span} reminder`;
}

/**
 * Why a message was skipped, or went by email instead of text, in plain words ("booked too close to the
 * time"); null when there's no reason. `name` is the customer's first name.
 */
export function reminderWhy(reason: string | null, name: string): string | null {
  const who = name || 'the customer';
  switch (reason) {
    case null:
    case '':
      return null;
    case 'booked_late':
      return 'booked too close to the time';
    case 'cancelled':
      return 'the booking was cancelled';
    case 'started':
      return 'the appointment had started';
    case 'reminders_off':
      return 'reminders are off for this calendar';
    case 'confirmation_off':
      return 'confirmations are off for this calendar';
    case 'quiet_hours':
      return 'it was quiet hours';
    case 'opted_out':
      return `${who} asked not to get texts`;
    case 'no_consent':
      return `${who} hasn’t agreed to texts`;
    case 'no_phone':
      return `there’s no phone number for ${who}`;
    case 'text_off':
      return 'this calendar doesn’t text';
    case 'texting_not_ready':
    case 'messaging_not_ready':
    case 'no_number':
      return 'texting isn’t set up yet';
    case 'no_contact':
      return `there’s no way to reach ${who} by text or email`;
    case 'no_email':
    case 'no_email_address':
      return `there’s no email for ${who}`;
    case 'email_off':
      return 'this calendar doesn’t email';
    case 'recipient_suppressed':
      return 'their email address is blocked (it bounced or was marked as spam)';
    case 'email_domain_unverified':
      return 'the sending domain isn’t verified';
    case 'invalid_contact':
      return 'the phone number or email isn’t valid';
    default:
      return reason.replace(/_/g, ' ');
  }
}

/** "16:00" → "4 PM", "16:30" → "4:30 PM". */
function clockText(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "the day before at 4 PM and 2 hours before"; empty when the calendar sends none. */
export function reminderSchedule(reminders: readonly Reminder[]): string {
  return andJoin(
    reminders.map((r) =>
      r.kind === 'day_before'
        ? `the day before at ${clockText(r.at)}`
        : `${formatDuration(r.minutes)} before`,
    ),
  );
}

export interface TellFacts {
  /** The customer's first name. */
  readonly name: string;
  /** They have a number texts can go to. */
  readonly phone: boolean;
  readonly email: boolean;
  /** Whether the business can text yet; null while unknown (taken as yes). */
  readonly textingReady: boolean | null;
}

type Channel = 'text' | 'email';

/**
 * The line under Tell: what the customer will get, from the calendar's notification settings and how they
 * can be reached. "Texts now, then reminders the day before at 4 PM and 2 hours before." A staff booking may
 * text any number that never said STOP, so no number, or texting not being set up yet, is what means email.
 * Unticked, there's no confirmation, but the reminders still go (the worker arms them either way).
 */
export function tellNote(n: Notifications, f: TellFacts, notify: boolean): string {
  const who = f.name || 'the customer';
  const textBlock = !f.phone
    ? `there’s no phone number for ${who}`
    : f.textingReady === false
      ? 'texting isn’t set up yet'
      : null;
  const via = (ch: { text: boolean; email: boolean }): Channel | null =>
    ch.text && !textBlock ? 'text' : ch.email && f.email ? 'email' : null;
  const schedule = reminderSchedule(n.reminders);
  const rem = schedule ? via(n.reminderChannels) : null;
  if (!notify)
    return rem ? `No confirmation now. Reminders still go ${schedule}.` : 'Nobody is told.';
  const conf = via(n.confirmation);
  if (!conf && !rem)
    return f.phone || f.email
      ? `Nothing is sent${textBlock ? `, since ${textBlock}` : ''}.`
      : `There’s no phone or email for ${who}, so nothing is sent.`;
  if (!conf) return `No confirmation now. Reminders go by ${rem} ${schedule}.`;
  if (conf === 'email' && rem !== 'text' && textBlock && n.confirmation.text)
    return `By email, since ${textBlock}: a confirmation now${rem ? `, then reminders ${schedule}` : ''}.`;
  const then = rem
    ? `, then ${rem === conf ? 'reminders' : rem === 'text' ? 'texts' : 'emails'} ${schedule}`
    : '';
  return `${conf === 'text' ? 'Texts' : 'Emails'} now${then}.`;
}
