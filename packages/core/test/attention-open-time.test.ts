import { describe, expect, it } from 'vitest';
import { addOpenTime, chipText, openTimeBetween } from '../src/attention/index';
import { at, HOUR, MIN, TZ, WEEKDAYS_8_TO_5 } from './attention-fixtures';

const t = (date: string, clock: string) => at(date, clock).getTime();

describe('open-hours time', () => {
  it('adds open minutes inside a day', () => {
    expect(addOpenTime(WEEKDAYS_8_TO_5, TZ, t('2026-09-15', '10:00'), 15 * MIN)).toBe(
      t('2026-09-15', '10:15'),
    );
  });

  it('carries past closing to the next open day', () => {
    expect(addOpenTime(WEEKDAYS_8_TO_5, TZ, t('2026-09-15', '16:55'), 15 * MIN)).toBe(
      t('2026-09-16', '08:10'),
    );
  });

  it('waits for Monday over a weekend, across a clock change', () => {
    expect(addOpenTime(WEEKDAYS_8_TO_5, TZ, t('2026-09-19', '10:00'), 15 * MIN)).toBe(
      t('2026-09-21', '08:15'),
    );
    // Daylight saving time ends on Sunday 1 November 2026.
    expect(addOpenTime(WEEKDAYS_8_TO_5, TZ, t('2026-10-30', '16:55'), 15 * MIN)).toBe(
      t('2026-11-02', '08:10'),
    );
  });

  it('is plain time for a business with no open hours', () => {
    const since = t('2026-09-15', '21:00');
    expect(addOpenTime([], TZ, since, 15 * MIN)).toBe(since + 15 * MIN);
    expect(openTimeBetween([], TZ, since, since + HOUR)).toBe(HOUR);
  });

  it('measures open time between two moments', () => {
    expect(
      openTimeBetween(WEEKDAYS_8_TO_5, TZ, t('2026-09-15', '16:00'), t('2026-09-16', '09:00')),
    ).toBe(2 * HOUR);
    expect(
      openTimeBetween(WEEKDAYS_8_TO_5, TZ, t('2026-09-18', '16:00'), t('2026-09-21', '09:00')),
    ).toBe(2 * HOUR);
    expect(
      openTimeBetween(WEEKDAYS_8_TO_5, TZ, t('2026-09-16', '09:00'), t('2026-09-15', '09:00')),
    ).toBe(0);
  });
});

describe('ticking chips', () => {
  const since = at('2026-09-15', '10:00');
  const plus = (ms: number) => since.getTime() + ms;

  it('recount a wait every minute, like the web’s waitingFor', () => {
    const chip = { code: 'waiting', label: 'just now', since: since.toISOString() } as const;
    expect(chipText(chip, plus(30_000))).toBe('just now');
    expect(chipText(chip, plus(11 * MIN))).toBe('waiting 11 min');
    expect(chipText(chip, plus(3 * HOUR + 5 * MIN))).toBe('waiting 3 h');
    expect(chipText(chip, plus(50 * HOUR))).toBe('waiting 2 d');
  });

  it('say when the last contact was, and count down to a start', () => {
    const last = { code: 'last_contact', label: '', since: since.toISOString() } as const;
    expect(chipText(last, plus(9 * 24 * HOUR))).toBe('Last contact 9 days ago');
    expect(chipText(last, plus(24 * HOUR))).toBe('Last contact 1 day ago');
    expect(chipText(last, plus(5 * HOUR))).toBe('Last contact 5 h ago');
    const starts = { code: 'starts_in', label: '', until: since.toISOString() } as const;
    expect(chipText(starts, plus(-5 * HOUR))).toBe('starts in 5 h');
    expect(chipText(starts, plus(-40 * MIN))).toBe('starts in 40 min');
    expect(chipText(starts, plus(0))).toBe('starting now');
  });

  it('keep fixed chips as they are', () => {
    expect(chipText({ code: 'qualified', label: 'qualified' }, since)).toBe('qualified');
  });
});
