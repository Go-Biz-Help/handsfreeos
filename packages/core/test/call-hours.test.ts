/**
 * The hours a call to a lead may go (AI calls, part 3): where the lead may be from their number and address, the
 * legal window there on a day (the federal 8 AM to 9 PM, stricter states, holidays, Canada), the business's own
 * calling hours narrowing it, and the first moment a call may start.
 */
import { describe, expect, it } from 'vitest';
import {
  CallHours,
  callPlacesOf,
  callWindowOn,
  nextCallMoment,
  parseAutomationSettings,
  regionOfAddress,
} from '../src/automations/index';

const at = (iso: string) => new Date(iso).getTime();
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const hours = (h: Partial<CallHours> = {}): CallHours => CallHours.parse(h);

describe('where a lead may be', () => {
  it('reads the state and its zone from the area code', () => {
    expect(callPlacesOf('+17135550100', null, 'UTC')).toEqual([
      { region: 'TX', timeZone: 'America/Chicago' },
    ]);
    // El Paso is Texas, on Mountain time.
    expect(callPlacesOf('+19155550100', null, 'UTC')).toEqual([
      { region: 'TX', timeZone: 'America/Denver' },
    ]);
    expect(callPlacesOf('+14165550100', null, 'UTC')).toEqual([
      { region: 'CA-ON', timeZone: 'America/Toronto' },
    ]);
  });

  it('adds every zone of an address in another state', () => {
    expect(callPlacesOf('+17135550100', { state: 'Florida' }, 'UTC')).toEqual([
      { region: 'TX', timeZone: 'America/Chicago' },
      { region: 'FL', timeZone: 'America/New_York' },
      { region: 'FL', timeZone: 'America/Chicago' },
    ]);
    // The same state as the number's: the area code already said which zone.
    expect(callPlacesOf('+13055550100', { state: 'FL' }, 'UTC')).toEqual([
      { region: 'FL', timeZone: 'America/New_York' },
    ]);
  });

  it('reads an address by its state, ZIP code or province', () => {
    expect(regionOfAddress({ state: 'tx' })).toBe('TX');
    expect(regionOfAddress({ postalCode: '33101' })).toBe('FL');
    expect(regionOfAddress({ country: 'Canada', postalCode: 'M5V 2T6' })).toBe('CA-ON');
    expect(regionOfAddress({ country: 'CA', state: 'Quebec' })).toBe('CA-QC');
    expect(regionOfAddress({ country: 'Mexico', state: 'Jalisco' })).toBeNull();
  });

  it('falls back to the business’s own zone when neither says', () => {
    expect(callPlacesOf('+447700900123', null, 'America/Chicago')).toEqual([
      { region: null, timeZone: 'America/Chicago' },
    ]);
  });
});

describe('the legal window on a day', () => {
  // 2026-11-04 is a Wednesday, 2026-11-07 a Saturday, 2026-11-08 a Sunday.
  it('is 8 AM to 9 PM where no state rule is stricter', () => {
    expect(callWindowOn(null, '2026-11-04')).toEqual({ start: 480, end: 1260 });
    expect(callWindowOn('NY', '2026-11-08')).toEqual({ start: 480, end: 1260 });
  });

  it('keeps the stricter states’ hours and days', () => {
    expect(callWindowOn('TX', '2026-11-04')).toEqual({ start: 540, end: 1260 });
    // Texas: noon on Sundays.
    expect(callWindowOn('TX', '2026-11-08')).toEqual({ start: 720, end: 1260 });
    expect(callWindowOn('FL', '2026-11-04')).toEqual({ start: 480, end: 1200 });
    expect(callWindowOn('AL', '2026-11-08')).toBeNull();
    expect(callWindowOn('ME', '2026-11-07')).toBeNull();
    expect(callWindowOn('RI', '2026-11-07')).toEqual({ start: 600, end: 1020 });
  });

  it('keeps Canada’s weekday and weekend hours', () => {
    expect(callWindowOn('CA-ON', '2026-11-04')).toEqual({ start: 540, end: 1290 });
    expect(callWindowOn('CA-ON', '2026-11-08')).toEqual({ start: 600, end: 1080 });
  });

  it('calls no one on a holiday where the state says so', () => {
    // Thanksgiving and the day after.
    expect(callWindowOn('FL', '2026-11-26')).toBeNull();
    expect(callWindowOn('FL', '2026-11-27')).toBeNull();
    // July 4th is a Saturday in 2026: kept on Friday the 3rd too.
    expect(callWindowOn('FL', '2026-07-03')).toBeNull();
    // Utah's Pioneer Day, Louisiana's Mardi Gras and Good Friday.
    expect(callWindowOn('UT', '2026-07-24')).toBeNull();
    expect(callWindowOn('UT', '2026-07-23')).not.toBeNull();
    expect(callWindowOn('LA', '2026-02-17')).toBeNull();
    expect(callWindowOn('LA', '2026-04-03')).toBeNull();
    // A state without the holiday rule calls on Thanksgiving within its hours.
    expect(callWindowOn('TX', '2026-11-26')).toEqual({ start: 540, end: 1260 });
  });

  it('narrows to the business’s calling hours, never widens', () => {
    const narrow = hours({ start: '10:00', end: '17:00' });
    expect(callWindowOn('TX', '2026-11-04', narrow)).toEqual({ start: 600, end: 1020 });
    // Texas’s Sunday noon still wins over a 10 AM start.
    expect(callWindowOn('TX', '2026-11-08', narrow)).toEqual({ start: 720, end: 1020 });
    expect(callWindowOn('TX', '2026-11-07', hours({ weekends: false }))).toBeNull();
    // Hours with less than 15 minutes left in a state's window leave no time that day.
    expect(callWindowOn('TX', '2026-11-04', hours({ start: '08:00', end: '09:00' }))).toBeNull();
  });
});

describe('the first moment a call may start', () => {
  const houston = callPlacesOf('+17135550100', null, 'UTC');
  const miami = callPlacesOf('+13055550100', null, 'UTC');

  it('is now when it may go at once', () => {
    // Wednesday 10:00 in Houston.
    const now = at('2026-11-04T16:00:00Z');
    expect(nextCallMoment(houston, hours(), now)).toBe(now);
  });

  it('waits for noon on a Texas Sunday', () => {
    // Sunday 10:00 in Houston: noon is 18:00 UTC.
    expect(iso(nextCallMoment(houston, hours(), at('2026-11-08T16:00:00Z')))).toBe(
      '2026-11-08T18:00:00.000Z',
    );
  });

  it('starts no later than 15 minutes before the hours end', () => {
    // Florida ends at 8 PM: 7:45 PM Eastern may start, 7:50 PM waits for 8 AM.
    expect(iso(nextCallMoment(miami, hours(), at('2026-11-05T00:45:00Z')))).toBe(
      '2026-11-05T00:45:00.000Z',
    );
    expect(iso(nextCallMoment(miami, hours(), at('2026-11-05T00:50:00Z')))).toBe(
      '2026-11-05T13:00:00.000Z',
    );
  });

  it('waits for a time that’s fine everywhere the lead may be', () => {
    // A Houston number and a Florida address, Wednesday 8:30 AM Eastern: Texas opens at 9 AM Central.
    const both = callPlacesOf('+17135550100', { state: 'FL' }, 'UTC');
    expect(iso(nextCallMoment(both, hours(), at('2026-11-04T13:30:00Z')))).toBe(
      '2026-11-04T15:00:00.000Z',
    );
  });

  it('steps over a holiday', () => {
    // Christmas Eve 9 PM in Salt Lake City; Christmas is off in Utah, the Saturday after isn’t.
    const utah = callPlacesOf('+18015550100', null, 'UTC');
    expect(iso(nextCallMoment(utah, hours(), at('2026-12-25T04:00:00Z')))).toBe(
      '2026-12-26T15:00:00.000Z',
    );
  });

  it('is null when the business’s hours fit no day the lead may be called', () => {
    expect(nextCallMoment(houston, hours({ start: '08:00', end: '09:00' }), Date.now())).toBeNull();
  });
});

describe('the business’s calling hours', () => {
  it('start as the law’s widest, with 3 tries', () => {
    const calls = parseAutomationSettings({}).calls;
    expect(calls.hours).toEqual({ start: '08:00', end: '21:00', weekends: true });
    expect(calls.tries).toBe(3);
  });

  it('refuse anything outside the legal hours, or shorter than an hour', () => {
    const problem = (h: unknown) => {
      const r = CallHours.safeParse(h);
      return r.success ? null : r.error.issues[0]!.message;
    };
    expect(problem({ start: '07:00' })).toMatch(/before 8 AM/);
    expect(problem({ end: '21:30' })).toMatch(/past 9 PM/);
    expect(problem({ start: '10:00', end: '10:30' })).toMatch(/at least an hour/);
    expect(problem({ start: '9am' })).toMatch(/like 9:00 AM/);
    expect(problem({ start: '09:00', end: '17:00', weekends: false })).toBeNull();
  });

  it('keep at most 3 tries', () => {
    expect(() => parseAutomationSettings({ calls: { tries: 4 } })).toThrow();
    expect(parseAutomationSettings({ calls: { tries: 1 } }).calls.tries).toBe(1);
  });
});
