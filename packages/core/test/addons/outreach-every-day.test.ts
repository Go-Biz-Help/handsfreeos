/**
 * Working every day, new messages only on the person's days (docs/outreach.md, decision 139): the extension works in
 * their hours every day while they keep working on other days, which is on unless they turned it off, and what starts
 * or nudges a conversation waits for one of their days.
 */
import { describe, expect, it } from 'vitest';
import {
  newMessagesWait,
  waitsForWorkDay,
  workHours,
  workWindow,
  worksEveryDay,
  type WorkingHours,
} from '../../src/addons/outreach/automation';
import { ownDayWords } from '../../src/addons/outreach/live';

const ZONE = 'America/Chicago';
const WEEKDAYS: WorkingHours = { start: 10, end: 18, days: [1, 2, 3, 4, 5] };
/** Saturday 31 Oct 2026, 11 AM in Chicago; and Monday 2 Nov, the same time. */
const SATURDAY = Date.parse('2026-10-31T16:00:00Z');
const MONDAY = Date.parse('2026-11-02T17:00:00Z');

describe('working every day (decision 139)', () => {
  it('is on unless turned off, hours kept before it too', () => {
    expect(worksEveryDay(WEEKDAYS)).toBe(true);
    expect(worksEveryDay({ ...WEEKDAYS, everyDay: true })).toBe(true);
    expect(worksEveryDay({ ...WEEKDAYS, everyDay: false })).toBe(false);
  });

  it('works the same hours on a day off, and only the person’s days once turned off', () => {
    expect(workWindow(workHours(WEEKDAYS), ZONE, SATURDAY)).toEqual({
      from: Date.parse('2026-10-31T15:00:00Z'),
      to: Date.parse('2026-10-31T23:00:00Z'),
    });
    expect(workWindow(workHours({ ...WEEKDAYS, everyDay: false }), ZONE, SATURDAY)).toBeNull();
    // The person's own hours keep their days, for the first messages' goal and the day's report.
    expect(workWindow(WEEKDAYS, ZONE, SATURDAY)).toBeNull();
  });

  it('holds new messages on a day off, and never on the person’s days or once turned off', () => {
    expect(newMessagesWait(WEEKDAYS, ZONE, SATURDAY)).toBe(true);
    expect(newMessagesWait(WEEKDAYS, ZONE, MONDAY)).toBe(false);
    expect(newMessagesWait({ ...WEEKDAYS, everyDay: false }, ZONE, SATURDAY)).toBe(false);
  });

  it('holds what starts or nudges a conversation, never what answers someone', () => {
    for (const kind of [
      'opener',
      'reconnect',
      'follow_up',
      'check_in',
      'partner_ask',
      'partner_follow_up',
    ])
      expect(waitsForWorkDay(kind)).toBe(true);
    for (const kind of [
      'reply',
      'pitch',
      'video',
      'demo_reminder',
      'rebook',
      'birthday',
      'new_job',
      'partner_reply',
      'partner_details',
      'comment',
      'warm_up',
      'friend_request',
    ])
      expect(waitsForWorkDay(kind)).toBe(false);
  });

  it('says Today goes on its own on a day off', () => {
    const day = { date: '2026-10-31', state: 'none', why: null, at: null } as never;
    const early = Date.parse('2026-10-31T13:00:00Z');
    expect(
      ownDayWords({ day, sending: 'steps', hours: WEEKDAYS, timezone: ZONE, now: early }),
    ).toMatch(/^Starts on its own (today )?at 10/);
    expect(
      ownDayWords({ day, sending: 'steps', hours: WEEKDAYS, timezone: ZONE, now: SATURDAY }),
    ).toMatch(/^Going on its own until 6/);
  });
});
