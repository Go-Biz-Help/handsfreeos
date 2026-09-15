/**
 * When things happen for the AI teammate (M7 step 7, ai-team/hours.ts), pure: what the hand-off line promises,
 * the line itself, the open time after a hand-off that sets off the unanswered alert, and when the teammate is
 * next at work. Chicago, around Tuesday 15 September 2026, with the default open hours (Mon–Fri 8 to 5).
 */
import {
  DEFAULT_OPEN_HOURS,
  emptyTeammateConfig,
  localInstant,
  weekdayOf,
  type TeammateConfig,
  type WeeklyHours,
} from '@hfos/core/server';
import { describe, expect, it } from 'vitest';
import {
  afterOpenTime,
  handoffExpectation,
  handoffLine,
  nextOpenAt,
  nextWorkingAt,
} from '../src/ai-team/hours';

const CHI = 'America/Chicago';
const TUE = '2026-09-15';
const WED = '2026-09-16';
const FRI = '2026-09-18';
const SAT = '2026-09-19';
const MON = '2026-09-21';
const at = (date: string, clock: string) => localInstant(date, clock, CHI);
const WHO = 'someone from our team will reply';

it('runs on the days it says', () => {
  expect([TUE, WED, FRI, SAT, MON].map(weekdayOf)).toEqual([2, 3, 5, 6, 1]);
});

describe('what the hand-off line promises', () => {
  it.each([
    [TUE, '10:00', `${WHO} shortly`],
    [TUE, '06:30', `${WHO} first thing this morning`],
    [TUE, '19:00', `${WHO} first thing tomorrow morning`],
    [FRI, '17:00', `${WHO} first thing Monday morning`],
    [SAT, '11:00', `${WHO} first thing Monday morning`],
  ])('%s at %s: “%s”', (date, clock, expected) => {
    expect(handoffExpectation(DEFAULT_OPEN_HOURS, CHI, at(date, clock))).toBe(expected);
  });

  it('names the time when the business opens after noon', () => {
    const afternoons: WeeklyHours = [
      { day: 2, start: '13:00', end: '18:00' },
      { day: 4, start: '13:30', end: '18:00' },
    ];
    expect(handoffExpectation(afternoons, CHI, at(TUE, '09:00'))).toBe(
      `${WHO} once we open at 1 PM`,
    );
    expect(handoffExpectation(afternoons, CHI, at(WED, '09:00'))).toBe(
      `${WHO} tomorrow once we open at 1:30 PM`,
    );
    expect(handoffExpectation(afternoons, CHI, at(FRI, '09:00'))).toBe(
      `${WHO} on Tuesday once we open at 1 PM`,
    );
  });

  it('promises nothing it can’t keep when the business has no open hours', () => {
    expect(handoffExpectation([], CHI, at(TUE, '10:00'))).toBe(`${WHO} as soon as they can`);
  });
});

describe('the hand-off line', () => {
  it('fills the business’s words in', () => {
    expect(
      handoffLine(
        "Thanks for your patience. I've passed this to our team, and {expectation}.",
        `${WHO} shortly`,
      ),
    ).toBe(
      "Thanks for your patience. I've passed this to our team, and someone from our team will reply shortly.",
    );
  });

  it('starts a sentence with a capital, and ends with a full stop the business left off', () => {
    expect(handoffLine('{expectation}', `${WHO} shortly`)).toBe(
      'Someone from our team will reply shortly.',
    );
    expect(handoffLine('Got it! {expectation}', `${WHO} shortly`)).toBe(
      'Got it! Someone from our team will reply shortly.',
    );
  });
});

describe('open time after a hand-off (the unanswered alert, 15 minutes)', () => {
  const FIFTEEN = 15 * 60_000;
  it('counts only the hours the business is open', () => {
    expect(afterOpenTime(DEFAULT_OPEN_HOURS, CHI, at(TUE, '10:00'), FIFTEEN)).toBe(
      at(TUE, '10:15'),
    );
    expect(afterOpenTime(DEFAULT_OPEN_HOURS, CHI, at(TUE, '16:55'), FIFTEEN)).toBe(
      at(WED, '08:10'),
    );
    expect(afterOpenTime(DEFAULT_OPEN_HOURS, CHI, at(SAT, '12:00'), FIFTEEN)).toBe(
      at(MON, '08:15'),
    );
  });

  it('is plain time when the business has no open hours', () => {
    expect(afterOpenTime([], CHI, at(TUE, '22:00'), FIFTEEN)).toBe(at(TUE, '22:15'));
  });

  it('knows when the business next opens', () => {
    expect(nextOpenAt(DEFAULT_OPEN_HOURS, CHI, at(TUE, '10:00'))).toBe(at(TUE, '10:00'));
    expect(nextOpenAt(DEFAULT_OPEN_HOURS, CHI, at(TUE, '19:00'))).toBe(at(WED, '08:00'));
    expect(nextOpenAt([], CHI, at(TUE, '19:00'))).toBeNull();
  });
});

describe('when the teammate is next at work', () => {
  const withHours = (hours: Partial<TeammateConfig['hours']>): TeammateConfig => {
    const base = emptyTeammateConfig();
    return { ...base, hours: { ...base.hours, ...hours } };
  };

  it('is now while it works', () => {
    const now = at(TUE, '22:00');
    expect(nextWorkingAt(withHours({ mode: 'always' }), DEFAULT_OPEN_HOURS, CHI, now)).toBe(now);
    expect(nextWorkingAt(withHours({ mode: 'after_hours' }), DEFAULT_OPEN_HOURS, CHI, now)).toBe(
      now,
    );
  });

  it('after hours: when the business closes', () => {
    expect(
      nextWorkingAt(withHours({ mode: 'after_hours' }), DEFAULT_OPEN_HOURS, CHI, at(TUE, '10:00')),
    ).toBe(at(TUE, '17:00'));
  });

  it('its own hours: the next time they start', () => {
    const custom = withHours({
      mode: 'custom',
      custom: [{ day: 3, start: '09:00', end: '12:00' }],
    });
    expect(nextWorkingAt(custom, DEFAULT_OPEN_HOURS, CHI, at(TUE, '10:00'))).toBe(at(WED, '09:00'));
  });
});
