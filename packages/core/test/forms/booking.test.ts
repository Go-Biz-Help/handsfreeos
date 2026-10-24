import { describe, expect, it } from 'vitest';
import {
  answerProblem,
  bookingLabel,
  bookingPicked,
  formProblems,
  isBookingAnswer,
  type Question,
} from '../../src/forms/index';
import { def, page, qid, shortText } from './fixtures';

const CAL = '11111111-1111-4111-8111-111111111111';
const booking = (name: string, config: Record<string, unknown> = { calendarId: CAL }) =>
  ({ id: qid(name), type: 'booking', title: name, config }) as never;

const picked = {
  startsAt: '2026-10-28T00:00:00.000Z',
  sessionId: '22222222-2222-4222-8222-222222222222',
  label: 'Tue, Oct 27 · 7:00 pm',
};

describe('a booking question', () => {
  it('reads a time where the calendar is', () => {
    expect(bookingLabel('2026-10-28T00:00:00.000Z', 'America/Chicago')).toBe(
      'Tue, Oct 27 · 7:00 pm',
    );
    expect(bookingLabel('2026-10-28T15:30:00.000Z', 'America/New_York')).toBe(
      'Wed, Oct 28 · 11:30 am',
    );
  });

  it('takes a time it can book, and nothing else', () => {
    expect(isBookingAnswer(picked)).toBe(true);
    expect(isBookingAnswer({ ...picked, sessionId: null })).toBe(true);
    expect(isBookingAnswer({ ...picked, startsAt: 'next tuesday' })).toBe(false);
    expect(isBookingAnswer({ ...picked, sessionId: 'not-an-id' })).toBe(false);
    expect(isBookingAnswer('Tuesday')).toBe(false);
    const q = def({ pages: [page('when', [booking('when')])] }).pages[0]!.questions[0] as Question;
    expect(answerProblem(q, picked)).toBeNull();
    expect(answerProblem(q, 'Tuesday')).toBe('Pick one of the times.');
  });

  it('finds what was picked', () => {
    const definition = def({ pages: [page('when', [shortText('name'), booking('when')])] });
    expect(bookingPicked(definition, { [qid('when')]: picked })?.answer).toEqual(picked);
    expect(bookingPicked(definition, {})).toBeNull();
  });

  it('needs a calendar, books one time, and never on an anonymous form', () => {
    expect(formProblems(def({ pages: [page('a', [booking('when', {})])] }))).toContain(
      '“when” needs a calendar to book on.',
    );
    expect(
      formProblems(def({ pages: [page('a', [booking('first'), booking('second')])] })).join(' '),
    ).toContain('A form can book one time.');
    expect(
      formProblems(
        def({ settings: { identity: 'anonymous' }, pages: [page('a', [booking('when')])] }),
      ).join(' '),
    ).toContain('an anonymous form keeps nobody to book it for');
  });
});
