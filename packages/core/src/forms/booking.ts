/**
 * Booking inside a form (funnels): a question whose answer is a time on one of the business's calendars, booked
 * when the form is sent. A funnel's last step shows the next Tuesday and Thursday sessions as buttons; one tap
 * picks one, and sending the form books it, so the calendar's own confirmation, video link and reminders go out.
 *
 * What the page shows, what an answer has to look like and how a time reads in words are here, so the page, the
 * editor and the server agree. Browser-safe. The booking itself is the calendar's own `appointment.book_online`,
 * run inside the send (`form_response.submit`), so a session that filled up meanwhile refuses the whole send and
 * nothing is half done.
 */
import { intlTimeZone } from '../intl/engine-zones';
import type { FormDefinition, Question } from './definition';
import type { AnswerSheet } from './logic';

/** What a booking question's answer holds: the time picked, the session it joins, and how it reads. */
export interface BookingAnswer {
  readonly startsAt: string;
  readonly sessionId: string | null;
  /** "Tue, Oct 28 · 7:00 pm", in the calendar's time zone. The server writes it again from the time itself. */
  readonly label: string;
}

/** How far ahead a booking question shows times, by default and at most. */
export const BOOKING_DAYS_DEFAULT = 14;
export const BOOKING_DAYS_MAX = 31;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a value is a booking answer we can use. */
export function isBookingAnswer(value: unknown): value is BookingAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['startsAt'] === 'string' &&
    ISO.test(v['startsAt']) &&
    Number.isFinite(Date.parse(v['startsAt'])) &&
    (v['sessionId'] === null ||
      (typeof v['sessionId'] === 'string' && UUID.test(v['sessionId']))) &&
    typeof v['label'] === 'string' &&
    v['label'].length <= 120
  );
}

/** "Tue, Oct 28 · 7:00 pm": a time as a customer reads it, where the calendar is. */
export function bookingLabel(startsAt: string | number, timeZone: string): string {
  const at = new Date(startsAt);
  const zone = intlTimeZone(timeZone);
  const day = at.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: zone,
  });
  const time = at
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone })
    .replace(/\s?AM$/, ' am')
    .replace(/\s?PM$/, ' pm');
  return `${day} · ${time}`;
}

/** "Tuesday, October 28": the heading a day's times sit under. */
export function bookingDay(startsAt: string | number, timeZone: string): string {
  return new Date(startsAt).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: intlTimeZone(timeZone),
  });
}

/** The booking question on a form, and what was picked for it, when there's an answer. */
export function bookingPicked(
  definition: Pick<FormDefinition, 'pages'>,
  answers: AnswerSheet,
): { question: Question; answer: BookingAnswer } | null {
  for (const page of definition.pages)
    for (const question of page.questions) {
      if (question.type !== 'booking') continue;
      const answer = answers[question.id];
      return isBookingAnswer(answer) ? { question, answer } : null;
    }
  return null;
}
