import { describe, expect, it } from 'vitest';
import {
  attendeeZoneOf,
  customerTimeZone,
  findZones,
  fmtAtPicked,
  instantOfInput,
  localInstant,
  moreZoneChoices,
  sameZone,
  zoneChoices,
  zonedInputValue,
  zoneNote,
  zonePickLabel,
} from '../../src/calendar/index';
import { formatDate } from '../../src/crm/format';
import { dueLabel } from '../../src/crm/task-words';

const CHI = 'America/Chicago';
const LA = 'America/Los_Angeles';
const MANILA = 'Asia/Manila';

describe('the time zone pick', () => {
  it('names the US zones the way the business setting does, and Arizona apart from Denver', () => {
    expect(zonePickLabel(CHI)).toBe('Central Time');
    expect(zonePickLabel('America/Phoenix')).toBe('Arizona Time');
    expect(zonePickLabel('America/Denver')).toBe('Mountain Time');
    expect(zonePickLabel('US/Pacific')).toBe('Pacific Time');
    expect(zonePickLabel(MANILA)).toContain('(Manila)');
  });

  it('lists the US zones, with a calendar zone off that list first', () => {
    expect(zoneChoices(CHI).map((z) => z.id)).toEqual([
      'America/New_York',
      CHI,
      'America/Denver',
      'America/Phoenix',
      LA,
      'America/Anchorage',
      'Pacific/Honolulu',
    ]);
    const abroad = zoneChoices(MANILA, 'Europe/London').map((z) => z.id);
    expect(abroad.slice(0, 2)).toEqual([MANILA, 'Europe/London']);
    expect(abroad).toHaveLength(9);
  });

  it('reads an older zone name as the same zone', () => {
    expect(sameZone('US/Central', CHI)).toBe(true);
    expect(sameZone(LA, CHI)).toBe(false);
  });

  it('says where a time set on another zone’s clock lands on the calendar', () => {
    // 2:00 PM Pacific on a Tuesday in November is 4:00 PM Central.
    const at = localInstant('2026-11-10', '14:00', LA);
    expect(new Date(at).toISOString()).toBe('2026-11-10T22:00:00.000Z');
    expect(zoneNote(at, LA, CHI)).toBe('That’s 4:00 PM Central Time on your calendar.');
    expect(zoneNote(at, CHI, CHI)).toBeNull();
    expect(fmtAtPicked(at, LA, CHI)).toBe('Tue, Nov 10 at 4:00 PM (2:00 PM Pacific Time)');
    expect(fmtAtPicked(at, CHI, CHI)).toBe('Tue, Nov 10 at 4:00 PM');
  });

  it('names the weekday when the day is different there', () => {
    // 9:00 AM Wednesday in Manila is 7:00 PM Tuesday in Chicago.
    const at = localInstant('2026-11-11', '09:00', MANILA);
    expect(zoneNote(at, MANILA, CHI)).toBe('That’s Tue 7:00 PM Central Time on your calendar.');
    expect(fmtAtPicked(at, MANILA, CHI)).toMatch(
      /^Tue, Nov 10 at 7:00 PM \(Wed 9:00 AM .+\(Manila\)\)$/,
    );
  });

  it('follows each zone’s own clock change', () => {
    // Arizona keeps standard time all year: 9 AM there is 10 AM Central in winter and 11 AM in summer.
    const winter = localInstant('2026-01-15', '09:00', 'America/Phoenix');
    const summer = localInstant('2026-07-15', '09:00', 'America/Phoenix');
    expect(zoneNote(winter, 'America/Phoenix', CHI)).toBe(
      'That’s 10:00 AM Central Time on your calendar.',
    );
    expect(zoneNote(summer, 'America/Phoenix', CHI)).toBe(
      'That’s 11:00 AM Central Time on your calendar.',
    );
  });
});

describe('more time zones', () => {
  it('lists every other zone by place, without the US ones', () => {
    const more = moreZoneChoices();
    expect(more.length).toBeGreaterThan(400);
    expect(more.find((z) => z.id === MANILA)?.label).toBe('Manila (Philippine Standard Time)');
    expect(more.find((z) => z.id === 'America/Indiana/Knox')?.label).toMatch(/^Knox, Indiana \(/);
    expect(more.some((z) => z.id === CHI)).toBe(false);
    expect(more.at(-1)).toEqual({ id: 'UTC', label: 'UTC' });
    const labels = more.slice(0, -1).map((z) => z.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
  });

  it('finds zones by what was typed, the US ones first', () => {
    expect(findZones('manila').map((z) => z.id)).toEqual([MANILA]);
    expect(findZones('pacific')[0]).toEqual({ id: LA, label: 'Pacific Time' });
    expect(findZones('los angeles')[0]?.id).toBe(LA);
    expect(findZones('  ')).toEqual([]);
    expect(findZones('a', 3)).toHaveLength(3);
  });

  it('names UTC as itself', () => {
    expect(zonePickLabel('Etc/UTC')).toBe('UTC');
  });
});

describe('a task’s or a follow-up’s time on the business’s clock', () => {
  it('fills and reads a date-and-time box on the picked zone', () => {
    const at = Date.parse('2026-11-10T22:00:00.000Z');
    expect(zonedInputValue(at, CHI)).toBe('2026-11-10T16:00');
    expect(zonedInputValue(at, LA)).toBe('2026-11-10T14:00');
    expect(zonedInputValue(at, MANILA, true)).toBe('2026-11-11');
    expect(instantOfInput('2026-11-10T16:00', CHI)).toBe(at);
    expect(instantOfInput('2026-11-10T14:00:00', LA)).toBe(at);
    // A date alone is noon there, where an all-day task is kept.
    expect(new Date(instantOfInput('2026-11-10', CHI)!).toISOString()).toBe(
      '2026-11-10T18:00:00.000Z',
    );
    expect(instantOfInput('', CHI)).toBeNull();
    expect(instantOfInput('2026-02-30T10:00', CHI)).toBeNull();
  });

  it('says where it lands for the business', () => {
    const at = localInstant('2026-11-10', '14:00', LA);
    expect(zoneNote(at, LA, CHI, 'for the business')).toBe(
      'That’s 4:00 PM Central Time for the business.',
    );
  });

  it('writes the due words on the business’s clock when its zone is given', () => {
    const now = new Date('2026-11-10T15:00:00.000Z');
    const due = { dueAt: '2026-11-10T22:00:00.000Z', allDay: false, doneAt: null };
    expect(dueLabel({ ...due, dueBucket: 'today' }, now, CHI).text).toBe('Today 4:00 PM');
    expect(dueLabel({ ...due, dueBucket: 'today' }, now, LA).text).toBe('Today 2:00 PM');
    expect(formatDate(due.dueAt, { time: true, timeZone: MANILA }, now)).toBe('Nov 11, 6:00 AM');
    // A year away from now on that zone's clock, not the device's.
    expect(
      formatDate('2027-01-01T03:00:00.000Z', { timeZone: CHI }, new Date('2026-12-31T12:00:00Z')),
    ).toBe('Dec 31');
  });
});

describe('the zone a customer is told a time in', () => {
  it('is theirs when known, else their address’s, else the calendar’s', () => {
    expect(customerTimeZone({ zone: 'US/Pacific', state: 'IL' }, CHI)).toBe(LA);
    expect(customerTimeZone({ zone: null, state: 'az', postalCode: '85004' }, CHI)).toBe(
      'America/Phoenix',
    );
    // A Florida panhandle ZIP is Central, the rest of the state Eastern.
    expect(customerTimeZone({ state: 'FL', postalCode: '32501' }, 'America/New_York')).toBe(CHI);
    expect(customerTimeZone({ state: 'FL', postalCode: '33101' }, CHI)).toBe('America/New_York');
    expect(customerTimeZone({ state: 'ON', country: 'CA' }, CHI)).toBe(CHI);
    expect(customerTimeZone({ zone: 'Not/AZone' }, CHI)).toBe(CHI);
    expect(customerTimeZone({}, MANILA)).toBe(MANILA);
  });

  it('is kept on a booking only when the time was set on another zone’s clock', () => {
    expect(attendeeZoneOf(LA, CHI)).toBe(LA);
    expect(attendeeZoneOf('US/Central', CHI)).toBeNull();
    expect(attendeeZoneOf(undefined, CHI)).toBeNull();
  });
});
