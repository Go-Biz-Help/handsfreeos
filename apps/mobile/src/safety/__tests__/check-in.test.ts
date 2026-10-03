import { PushData } from '@hfos/core';

import { pressAction } from '@/push/buttons';

import {
  activeCheckIn,
  endAfterAdding,
  reminderAt,
  reminderData,
  reminderId,
  safetyTimesOf,
  toldOf,
  type CheckInRow,
} from '../check-in';

/**
 * A check-in on the phone (round six): the open one the banner shows, the time +15 min gives, and the reminder the
 * phone sets for the planned end, which must be the server's push in all but its ids, so its buttons work the same.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = Date.parse('2026-10-03T21:00:00.000Z');
const row = (over: Partial<CheckInRow>): CheckInRow => ({
  id: '66666666-6666-4666-8666-666666666666',
  workspace_id: WS,
  user_id: '11111111-1111-4111-8111-111111111111',
  place: '2207 Juniper Trail',
  started_at: '2026-10-03T20:00:00.000Z',
  planned_end_at: '2026-10-03T21:30:00.000Z',
  state: 'in',
  appointment_id: null,
  extended_count: 0,
  ...over,
});

describe('the open check-in', () => {
  it('is the newest still going, and says when it’s past its planned end', () => {
    expect(
      activeCheckIn(
        [
          row({ id: '1', state: 'out', started_at: '2026-10-03T20:50:00.000Z' }),
          row({ id: '2', started_at: '2026-10-03T20:10:00.000Z' }),
          row({ id: '3', state: 'ok' }),
        ],
        NOW,
      ),
    ).toMatchObject({ id: '2', overdue: false, state: 'in' });
    expect(activeCheckIn([row({ planned_end_at: '2026-10-03T20:55:00.000Z' })], NOW)?.overdue).toBe(
      true,
    );
    expect(activeCheckIn([row({ state: 'out' })], NOW)).toBeNull();
  });

  it('gains fifteen minutes from its planned end, or from now once that’s passed', () => {
    expect(endAfterAdding('2026-10-03T21:30:00.000Z', 15, NOW)).toBe('2026-10-03T21:45:00.000Z');
    expect(endAfterAdding('2026-10-03T20:30:00.000Z', 15, NOW)).toBe('2026-10-03T21:15:00.000Z');
  });
});

describe('the reminder at the planned end', () => {
  let n = 0;
  const data = reminderData({
    checkInId: '66666666-6666-4666-8666-666666666666',
    workspaceId: WS,
    business: 'Hill Country Realty',
    place: '2207 Juniper Trail',
    plannedEndAt: '2026-10-03T21:30:00.000Z',
    timeZone: 'America/Chicago',
    contacts: ['Marcus'],
    alertAfterMinutes: 10,
    newId: () => `10000000-0000-4000-8000-00000000000${++n}`,
  });

  it('is the server’s “Still at …?” push, with the same words and the same notification id', () => {
    expect(PushData.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      category: 'safety_check',
      collapseId: reminderId('66666666-6666-4666-8666-666666666666'),
      title: 'Still at 2207 Juniper Trail?',
      body: 'You planned to check out at 4:30 PM. If you don’t answer in 10 minutes, Marcus is told.',
      refs: { checkInId: '66666666-6666-4666-8666-666666666666' },
    });
  });

  it('checks out and adds time from its buttons, as the server’s does', () => {
    const at = Date.parse('2026-10-03T21:31:00.000Z');
    expect(pressAction({ data, actionId: 'im_ok', typed: null, pressedAt: at })).toMatchObject({
      kind: 'command',
      command: { name: 'safety.check_out' },
      commandId: data.commandIds.im_ok,
    });
    expect(pressAction({ data, actionId: 'add_15', typed: null, pressedAt: at })).toMatchObject({
      kind: 'command',
      command: { name: 'safety.extend', input: { minutes: 15 } },
      commandId: data.commandIds.add_15,
    });
  });
});

describe('what the reminder reads from the phone’s copy', () => {
  it('takes the business’s times as the worker does, else its defaults', () => {
    expect(
      safetyTimesOf(JSON.stringify({ safety: { askAfterMinutes: 5, alertAfterMinutes: 20 } })),
    ).toEqual({
      askAfterMinutes: 5,
      alertAfterMinutes: 20,
    });
    expect(
      safetyTimesOf(JSON.stringify({ safety: { askAfterMinutes: 90, alertAfterMinutes: 0 } })),
    ).toEqual({
      askAfterMinutes: 0,
      alertAfterMinutes: 1,
    });
    expect(safetyTimesOf(null)).toEqual({ askAfterMinutes: 0, alertAfterMinutes: 10 });
    expect(safetyTimesOf('not json')).toEqual({ askAfterMinutes: 0, alertAfterMinutes: 10 });
  });

  it('names teammates still on the team and people outside who agreed', () => {
    const k = (
      contact_user_id: string | null,
      name: string,
      agreed_at: string | null,
      stopped_at: string | null = null,
    ) => ({
      contact_user_id,
      name,
      agreed_at,
      stopped_at,
    });
    expect(
      toldOf(
        [
          k('u1', 'Marcus Lee', null),
          k('u2', 'Gone Away', null),
          k(null, 'Dana Ruiz', '2026-09-01'),
          k(null, 'Not Yet', null),
          k(null, 'Said Stop', '2026-09-01', '2026-09-02'),
        ],
        new Set(['u1']),
      ),
    ).toEqual(['Marcus', 'Dana']);
  });

  it('asks after the business’s wait', () => {
    expect(reminderAt('2026-10-03T21:30:00.000Z', 5)).toEqual(new Date('2026-10-03T21:35:00.000Z'));
  });
});
