/**
 * Real Estate Agent's dates (step 7), without a database: the federal holidays as observed for 2026 to 2028, business
 * days around them and a business's own closed days, due times that land at 11:59 pm local across a clock change,
 * calendar-day deadlines that keep their date on a day off and say so, traces that replay, and the checks across a
 * deal's dates.
 */
import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  businessDaysBetween,
  dayOff,
  nextBusinessDay,
} from '../../src/addons/realestate/dates/business-days';
import { checkDealDates } from '../../src/addons/realestate/dates/conflicts';
import { resolveDue } from '../../src/addons/realestate/dates/due';
import { federalHolidays, HOLIDAY_RULES_VERSION } from '../../src/addons/realestate/dates/holidays';
import type { KeyDates } from '../../src/addons/realestate/dates/key-dates';
import { localInstant } from '../../src/calendar/engine/zoned';

const CHI = 'America/Chicago';
const at = (date: string, clock: string) => localInstant(date, clock, CHI);
const typed = (date: string, time: string | null = null, confirmed = true) => ({
  date,
  time,
  source: 'contract' as const,
  confirmed,
});

describe('federal holidays, as observed', () => {
  const dates = (year: number) => federalHolidays(year).map((h) => h.date);

  it('moves a Saturday one to the Friday before and a Sunday one to the Monday after', () => {
    expect(dates(2026)).toEqual([
      '2026-01-01',
      '2026-01-19',
      '2026-02-16',
      '2026-05-25',
      '2026-06-19',
      '2026-07-03', // July 4 is a Saturday
      '2026-09-07',
      '2026-10-12',
      '2026-11-11',
      '2026-11-26',
      '2026-12-25',
    ]);
    expect(dates(2027)).toEqual([
      '2027-01-01',
      '2027-01-18',
      '2027-02-15',
      '2027-05-31',
      '2027-06-18', // Juneteenth is a Saturday
      '2027-07-05', // July 4 is a Sunday
      '2027-09-06',
      '2027-10-11',
      '2027-11-11',
      '2027-11-25',
      '2027-12-24', // Christmas is a Saturday
      '2027-12-31', // New Year's Day 2028 is a Saturday
    ]);
    expect(dates(2028)).toEqual([
      '2028-01-17',
      '2028-02-21',
      '2028-05-29',
      '2028-06-19',
      '2028-07-04',
      '2028-09-04',
      '2028-10-09',
      '2028-11-10', // Veterans Day is a Saturday
      '2028-11-23',
      '2028-12-25',
    ]);
  });

  it('counts Juneteenth from 2021', () => {
    expect(federalHolidays(2020).some((h) => h.name.startsWith('Juneteenth'))).toBe(false);
    expect(federalHolidays(2021).some((h) => h.name.startsWith('Juneteenth'))).toBe(true);
  });
});

describe('business days', () => {
  const closed = { closedDays: new Map([['2026-12-24', 'Christmas Eve']]) };

  it('skips weekends, observed holidays and the business’s own closed days, and says which', () => {
    expect(dayOff('2026-07-03')).toEqual({ reason: 'holiday', name: 'Independence Day' });
    expect(dayOff('2026-07-04')).toEqual({ reason: 'weekend' });
    expect(dayOff('2026-12-24', closed)).toEqual({ reason: 'closed', name: 'Christmas Eve' });
    const moved = addBusinessDays('2026-07-02', 1);
    expect(moved.date).toBe('2026-07-06');
    expect(moved.skipped.map((s) => s.date)).toEqual(['2026-07-03', '2026-07-04', '2026-07-05']);
    // Back past the weekend, Christmas and the business's own Christmas Eve.
    expect(addBusinessDays('2026-12-28', -3, closed).date).toBe('2026-12-21');
    expect(nextBusinessDay('2026-11-26')).toBe('2026-11-27');
    expect(businessDaysBetween('2026-11-25', '2026-11-30')).toBe(2);
    expect(businessDaysBetween('2026-11-30', '2026-11-25')).toBe(-2);
  });
});

describe('when a duty is due', () => {
  const base = { timeZone: CHI, startedAt: at('2026-10-30', '10:00') };

  it('puts a date with no time at 11:59 pm local, the same across the clocks changing', () => {
    const r = resolveDue(
      { kind: 'relative', to: 'closing', days: -3 },
      { ...base, keyDates: { closing: typed('2026-11-04') } },
    );
    expect(r).toMatchObject({ state: 'due', date: '2026-11-01', time: '23:59' });
    // 11:59 pm Central is 05:59 UTC once the clocks go back on Nov 1, 04:59 before.
    expect(r.dueAt).toBe('2026-11-02T05:59:00.000Z');
    const before = resolveDue(
      { kind: 'relative', to: 'closing', days: -5 },
      { ...base, keyDates: { closing: typed('2026-11-04') } },
    );
    expect(before.dueAt).toBe('2026-10-31T04:59:00.000Z');
    expect(r.rulesVersion).toBe(HOLIDAY_RULES_VERSION);
  });

  it('keeps a calendar-day deadline on a weekend or holiday, and warns', () => {
    const r = resolveDue(
      { kind: 'relative', to: 'acceptance', days: 3 },
      { ...base, keyDates: { acceptance: typed('2026-07-01') } },
    );
    expect(r.date).toBe('2026-07-04');
    expect(r.warnings).toEqual([
      { code: 'not_a_business_day', date: '2026-07-04', off: { reason: 'weekend' } },
    ]);
  });

  it('counts business days past a holiday, and keeps each skipped day in the trace', () => {
    const r = resolveDue(
      { kind: 'relative', to: 'closing', businessDays: -3 },
      { ...base, keyDates: { closing: typed('2026-11-30', '14:00') } },
    );
    expect(r.date).toBe('2026-11-24');
    expect(r.warnings).toEqual([]);
    expect(r.trace).toEqual([
      {
        step: 'anchor',
        key: 'closing',
        date: '2026-11-30',
        time: '14:00',
        source: 'contract',
        confirmed: true,
      },
      {
        step: 'offset',
        unit: 'business_days',
        by: -3,
        from: '2026-11-30',
        to: '2026-11-24',
        skipped: [
          { date: '2026-11-29', off: { reason: 'weekend' } },
          { date: '2026-11-28', off: { reason: 'weekend' } },
          { date: '2026-11-26', off: { reason: 'holiday', name: 'Thanksgiving Day' } },
        ],
      },
      { step: 'time', clock: '23:59', why: 'end_of_day' },
    ]);
  });

  it('uses the date’s own time when due on it, and says when it rests on an unconfirmed date', () => {
    const r = resolveDue(
      { kind: 'relative', to: 'inspection_end' },
      { ...base, keyDates: { inspection_end: typed('2026-11-06', '17:00', false) } },
    );
    expect(r).toMatchObject({ date: '2026-11-06', time: '17:00', unconfirmed: ['inspection_end'] });
  });

  it('waits for a date that isn’t in, and for the earliest of several until all are', () => {
    expect(
      resolveDue({ kind: 'relative', to: 'closing', days: -3 }, { ...base, keyDates: {} }),
    ).toMatchObject({ state: 'waiting', missing: ['closing'], dueAt: null });
    const rule = {
      kind: 'earliest' as const,
      of: [
        { kind: 'relative' as const, to: 'acceptance' as const, days: 3 },
        { kind: 'relative' as const, to: 'inspection_end' as const, days: -4 },
      ],
    };
    const partial: KeyDates = { acceptance: typed('2026-10-01') };
    expect(resolveDue(rule, { ...base, keyDates: partial }).state).toBe('waiting');
    const both: KeyDates = { ...partial, inspection_end: typed('2026-10-06') };
    const r = resolveDue(rule, { ...base, keyDates: both });
    expect(r.date).toBe('2026-10-02');
    expect(r.trace.at(-1)).toEqual({ step: 'pick', rule: 'earliest', chose: 1 });
  });

  it('counts from when it began: hours, days and business days', () => {
    expect(resolveDue({ kind: 'after_start', hours: 2 }, { ...base, keyDates: {} })).toMatchObject({
      date: '2026-10-30',
      time: '12:00',
    });
    expect(
      resolveDue({ kind: 'after_start', businessDays: 1 }, { ...base, keyDates: {} }),
    ).toMatchObject({ date: '2026-11-02', time: '23:59' });
    expect(resolveDue({ kind: 'ongoing' }, { ...base, keyDates: {} }).state).toBe('none');
  });
});

describe('checks across a deal’s dates', () => {
  const today = '2026-11-20';

  it('finds what can’t be right, most serious first', () => {
    const found = checkDealDates({
      side: 'buyer',
      financed: true,
      // Three business days before a Saturday closing, past Thanksgiving: no Closing Disclosure yet.
      today: '2026-11-24',
      keyDates: {
        acceptance: typed('2026-11-02'),
        inspection_end: typed('2026-12-02'),
        closing: typed('2026-11-28'),
        rate_lock_expiry: typed('2026-11-25'),
        preapproval_expiry: typed('2026-11-15'),
      },
      linkedSaleClosing: '2026-12-01',
    });
    expect(found.map((f) => [f.check, f.severity])).toEqual([
      ['contingency_after_closing', 'problem'],
      ['rate_lock_before_closing', 'problem'],
      ['closing_disclosure_timing', 'problem'],
      ['linked_sale_after_purchase', 'problem'],
      ['closing_not_business_day', 'warning'],
      ['preapproval_before_closing', 'warning'],
    ]);
    expect(found[1]!.words).toBe(
      'The rate lock ends Wed, Nov 25, before closing on Sat, Nov 28. Ask the lender about extending it.',
    );
  });

  it('says nothing about dates that are fine', () => {
    expect(
      checkDealDates({
        side: 'listing',
        today,
        keyDates: {
          acceptance: typed('2026-11-02'),
          inspection_end: typed('2026-11-12'),
          closing: typed('2026-12-04'),
          listing_agreement_expiry: typed('2027-02-01'),
        },
      }),
    ).toEqual([]);
  });

  it('wants the Closing Disclosure three business days before closing', () => {
    const late = checkDealDates({
      side: 'buyer',
      financed: true,
      today,
      keyDates: { closing: typed('2026-12-04'), cd_received: typed('2026-12-02') },
    });
    expect(late.map((f) => f.check)).toEqual(['closing_disclosure_timing']);
    const onTime = checkDealDates({
      side: 'buyer',
      financed: true,
      today,
      keyDates: { closing: typed('2026-12-04'), cd_received: typed('2026-12-01') },
    });
    expect(onTime).toEqual([]);
  });
});
