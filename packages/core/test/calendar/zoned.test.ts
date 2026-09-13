import { describe, expect, it } from 'vitest';
import {
  expandRecurrence,
  expandWeeklyHours,
  localInstant,
  recurrenceDates,
  RecurrenceRule,
  zonedInstants,
  zonedParts,
  zonedTime,
  zoneOffsetMinutes,
} from '../../src/calendar/index';

const CHI = 'America/Chicago';
const iso = (at: number | Date) => new Date(at).toISOString();
const rule = (input: Record<string, unknown>) => RecurrenceRule.parse(input);

describe('zoned time in America/Chicago', () => {
  it('reads ordinary wall times in both offsets', () => {
    expect(iso(zonedTime(2026, 1, 15, 9, 0, CHI))).toBe('2026-01-15T15:00:00.000Z');
    expect(iso(zonedTime(2026, 7, 1, 9, 0, CHI))).toBe('2026-07-01T14:00:00.000Z');
    expect(zonedParts(Date.parse('2026-07-01T14:00:00Z'), CHI)).toEqual({
      year: 2026,
      month: 7,
      day: 1,
      hour: 9,
      minute: 0,
      weekday: 3,
    });
  });

  it('2:30 AM on 2026-03-08 never happens and is read an hour later on the clock (3:30 AM CDT), like Postgres', () => {
    expect(zonedInstants(2026, 3, 8, 2, 30, CHI)).toEqual([]);
    const at = zonedTime(2026, 3, 8, 2, 30, CHI);
    expect(iso(at)).toBe('2026-03-08T08:30:00.000Z');
    expect(zonedParts(at, CHI)).toMatchObject({ hour: 3, minute: 30 });
    expect(zoneOffsetMinutes(Date.parse('2026-03-08T07:59:00Z'), CHI)).toBe(-360);
    expect(zoneOffsetMinutes(Date.parse('2026-03-08T08:00:00Z'), CHI)).toBe(-300);
  });

  it('1:30 AM on 2026-11-01 happens twice; the time is read as the second (CST), like Postgres', () => {
    const both = zonedInstants(2026, 11, 1, 1, 30, CHI);
    expect(both.map(iso)).toEqual(['2026-11-01T06:30:00.000Z', '2026-11-01T07:30:00.000Z']);
    for (const at of both) expect(zonedParts(at, CHI)).toMatchObject({ hour: 1, minute: 30 });
    expect(iso(zonedTime(2026, 11, 1, 1, 30, CHI))).toBe('2026-11-01T07:30:00.000Z');
  });

  it('keeps the edges of each change exact', () => {
    expect(iso(zonedTime(2026, 3, 8, 1, 59, CHI))).toBe('2026-03-08T07:59:00.000Z');
    expect(iso(zonedTime(2026, 3, 8, 3, 0, CHI))).toBe('2026-03-08T08:00:00.000Z');
    expect(iso(zonedTime(2026, 11, 1, 0, 59, CHI))).toBe('2026-11-01T05:59:00.000Z');
    expect(iso(zonedTime(2026, 11, 1, 2, 0, CHI))).toBe('2026-11-01T08:00:00.000Z');
  });

  it('turns hours into windows of the right length on change days', () => {
    const day = (date: string, start: string, end: string) => {
      const from = localInstant(date, '00:00', CHI) - 3_600_000;
      const to = localInstant(date, '24:00', CHI) + 3_600_000;
      const [w] = expandWeeklyHours([{ day: 0, start, end }], from, to, CHI);
      return (w!.end - w!.start) / 3_600_000;
    };
    expect(day('2026-03-08', '09:00', '17:00')).toBe(8);
    expect(day('2026-11-01', '09:00', '17:00')).toBe(8);
    expect(day('2026-03-08', '00:00', '03:00')).toBe(2);
    expect(day('2026-11-01', '00:00', '03:00')).toBe(4);
    expect(day('2026-03-08', '00:00', '24:00')).toBe(23);
    expect(day('2026-11-01', '00:00', '24:00')).toBe(25);
  });
});

describe('recurrence', () => {
  it('keeps a weekly 9:00 AM series at 9:00 across the spring change (15:00Z → 14:00Z)', () => {
    const out = expandRecurrence(
      rule({ freq: 'weekly', localTime: '09:00', count: 3 }),
      '2026-03-02',
      CHI,
    );
    expect(out.map((o) => iso(o.startsAt))).toEqual([
      '2026-03-02T15:00:00.000Z',
      '2026-03-09T14:00:00.000Z',
      '2026-03-16T14:00:00.000Z',
    ]);
    expect(out.map((o) => o.index)).toEqual([0, 1, 2]);
  });

  it('keeps it at 9:00 across the fall change (14:00Z → 15:00Z)', () => {
    const out = expandRecurrence(
      rule({ freq: 'weekly', localTime: '09:00', count: 2 }),
      '2026-10-26',
      CHI,
    );
    expect(out.map((o) => iso(o.startsAt))).toEqual([
      '2026-10-26T14:00:00.000Z',
      '2026-11-02T15:00:00.000Z',
    ]);
  });

  it('applies the gap and repeat rules to occurrences that land on them', () => {
    const spring = expandRecurrence(
      rule({ freq: 'weekly', localTime: '02:30', count: 2 }),
      '2026-03-01',
      CHI,
    );
    expect(spring.map((o) => iso(o.startsAt))).toEqual([
      '2026-03-01T08:30:00.000Z',
      '2026-03-08T08:30:00.000Z',
    ]);
    const fall = expandRecurrence(
      rule({ freq: 'weekly', localTime: '01:30', count: 2 }),
      '2026-10-25',
      CHI,
    );
    expect(fall.map((o) => iso(o.startsAt))).toEqual([
      '2026-10-25T06:30:00.000Z',
      '2026-11-01T07:30:00.000Z',
    ]);
  });

  it('repeats every other week on chosen weekdays', () => {
    const r = rule({ freq: 'weekly', interval: 2, weekdays: [1, 3], localTime: '10:00', count: 4 });
    expect(recurrenceDates(r, '2026-09-09')).toEqual([
      '2026-09-09',
      '2026-09-21',
      '2026-09-23',
      '2026-10-05',
    ]);
  });

  it('repeats on the same date, skipping months without it', () => {
    const r = rule({ freq: 'monthly_date', localTime: '10:00', count: 4 });
    expect(recurrenceDates(r, '2026-01-31')).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
      '2026-07-31',
    ]);
  });

  it('repeats on the same weekday of the month', () => {
    const r = rule({ freq: 'monthly_nth', localTime: '10:00', count: 3 });
    expect(recurrenceDates(r, '2026-09-08')).toEqual(['2026-09-08', '2026-10-13', '2026-11-10']);
  });

  it('stops at the until date, 52 occurrences and 12 months', () => {
    expect(
      recurrenceDates(
        rule({ freq: 'weekly', localTime: '10:00', until: '2026-09-28' }),
        '2026-09-14',
      ),
    ).toEqual(['2026-09-14', '2026-09-21', '2026-09-28']);
    const daily = recurrenceDates(
      rule({ freq: 'weekly', weekdays: [1, 2, 3, 4, 5], localTime: '10:00', until: '2027-06-01' }),
      '2026-09-14',
    );
    expect(daily).toHaveLength(52);
    const monthly = recurrenceDates(
      rule({ freq: 'monthly_date', localTime: '10:00', until: '2028-12-31' }),
      '2026-09-14',
    );
    expect(monthly).toHaveLength(13);
    expect(monthly.at(-1)).toBe('2027-09-14');
  });

  it('validates the rule', () => {
    expect(RecurrenceRule.safeParse({ freq: 'weekly', localTime: '09:00' }).success).toBe(false);
    expect(
      RecurrenceRule.safeParse({ freq: 'weekly', localTime: '09:00', count: 53 }).success,
    ).toBe(false);
    expect(
      RecurrenceRule.safeParse({ freq: 'weekly', localTime: '09:00', count: 2, interval: 13 })
        .success,
    ).toBe(false);
    expect(RecurrenceRule.safeParse({ freq: 'daily', localTime: '09:00', count: 2 }).success).toBe(
      false,
    );
  });
});
