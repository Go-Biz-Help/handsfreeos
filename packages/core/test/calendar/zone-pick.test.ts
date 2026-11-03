import { describe, expect, it } from 'vitest';
import {
  fmtAtPicked,
  localInstant,
  sameZone,
  zoneChoices,
  zoneNote,
  zonePickLabel,
} from '../../src/calendar/index';

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
