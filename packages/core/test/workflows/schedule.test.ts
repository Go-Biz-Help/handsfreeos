import { describe, expect, it } from 'vitest';
import { Cadence, nextOccurrence, upcomingOccurrences } from '../../src/workflows/index';

const TZ = 'America/Chicago';
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
const weekly = (days: number[], time: string) => Cadence.parse({ every: 'weekly', days, at: time });
const monthly = (day: number | 'last', time: string) =>
  Cadence.parse({ every: 'monthly', day, at: time });

describe('nextOccurrence across daylight saving (America/Chicago)', () => {
  it('keeps 9:00 AM on the clock when the clocks spring forward (2026-03-08)', () => {
    const sundays = upcomingOccurrences(weekly([0], '09:00'), at('2026-02-28T12:00:00Z'), TZ, 2);
    expect(sundays.map(iso)).toEqual(['2026-03-01T15:00:00.000Z', '2026-03-08T14:00:00.000Z']);
    const daily = upcomingOccurrences(
      weekly([0, 1, 2, 3, 4, 5, 6], '09:00'),
      at('2026-03-06T12:00:00Z'),
      TZ,
      4,
    );
    expect(daily.map(iso)).toEqual([
      '2026-03-06T15:00:00.000Z',
      '2026-03-07T15:00:00.000Z',
      '2026-03-08T14:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
    ]);
  });

  it('runs a skipped 2:30 AM an hour later on the clock', () => {
    expect(iso(nextOccurrence(weekly([0], '02:30'), at('2026-03-08T06:00:00Z'), TZ))).toBe(
      '2026-03-08T08:30:00.000Z',
    );
  });

  it('keeps 9:00 AM when the clocks fall back (2026-11-01), and runs a repeated 1:30 AM once, at the second', () => {
    const sundays = upcomingOccurrences(weekly([0], '09:00'), at('2026-10-24T12:00:00Z'), TZ, 2);
    expect(sundays.map(iso)).toEqual(['2026-10-25T14:00:00.000Z', '2026-11-01T15:00:00.000Z']);
    const early = upcomingOccurrences(weekly([0], '01:30'), at('2026-11-01T05:00:00Z'), TZ, 2);
    expect(early.map(iso)).toEqual(['2026-11-01T07:30:00.000Z', '2026-11-08T07:30:00.000Z']);
  });

  it('is strictly after the given time', () => {
    expect(iso(nextOccurrence(weekly([1], '09:00'), at('2026-09-14T14:00:00Z'), TZ))).toBe(
      '2026-09-21T14:00:00.000Z',
    );
  });
});

describe('monthly', () => {
  it('handles the last day, the first, and a DST month', () => {
    expect(iso(nextOccurrence(monthly('last', '09:00'), at('2026-02-10T12:00:00Z'), TZ))).toBe(
      '2026-02-28T15:00:00.000Z',
    );
    expect(iso(nextOccurrence(monthly('last', '09:00'), at('2026-04-01T12:00:00Z'), TZ))).toBe(
      '2026-04-30T14:00:00.000Z',
    );
    expect(iso(nextOccurrence(monthly(1, '09:00'), at('2026-11-01T16:00:00Z'), TZ))).toBe(
      '2026-12-01T15:00:00.000Z',
    );
    expect(
      upcomingOccurrences(monthly(8, '09:00'), at('2026-02-09T00:00:00Z'), TZ, 2).map(iso),
    ).toEqual(['2026-03-08T14:00:00.000Z', '2026-04-08T14:00:00.000Z']);
  });
});
