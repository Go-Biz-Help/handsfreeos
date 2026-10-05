import * as Notifications from 'expo-notifications';

import type { ChangeOptions } from '@/changes';
import { FakePowerSync } from '@/changes/__tests__/fake-powersync';

import { changeFromPress } from '../actions';
import { reminderId } from '../check-in';

/**
 * The reminder's buttons with no signal (round six): +15 min moves the check-in and its reminder on this phone, and the
 * reminder says what the server's would (the business's time zone and times, the contacts who'd be told); I'm OK checks
 * out here and clears it. On real SQLite with the phone's own tables, so the SQL is the phone's.
 */

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ME = '11111111-1111-4111-8111-111111111111';
const MATE = '22222222-2222-4222-8222-222222222222';
const GONE = '33333333-3333-4333-8333-333333333333';
const CHECK_IN = '66666666-6666-4666-8666-666666666666';
const PRESSED = Date.parse('2026-10-01T21:35:00.000Z');

type Scheduled = { identifier: string; content: { body: string }; trigger: { date: Date } };
const scheduled = () =>
  (Notifications as unknown as { __presented: Scheduled[] }).__presented.filter(
    (n) => n.identifier === reminderId(CHECK_IN),
  );

function phone(settings: unknown) {
  const db = new FakePowerSync();
  const put = (sql: string, ...args: (string | number | null)[]) =>
    db.sqlite.prepare(sql).run(...args);
  put(
    'INSERT INTO workspaces (id, name, timezone, settings) VALUES (?, ?, ?, ?)',
    WS,
    'Hill Country Realty',
    'America/Chicago',
    JSON.stringify(settings),
  );
  put(
    `INSERT INTO safety_checkins (id, workspace_id, user_id, place, started_at, planned_end_at, state,
       extended_count) VALUES (?, ?, ?, ?, ?, ?, 'asked', 0)`,
    CHECK_IN,
    WS,
    ME,
    '2207 Juniper Trail',
    '2026-10-01T20:00:00.000Z',
    '2026-10-01T21:30:00.000Z',
  );
  const contact = (
    id: string,
    user: string | null,
    name: string,
    agreed: string | null,
    n: number,
  ) =>
    put(
      `INSERT INTO safety_contacts (id, workspace_id, user_id, contact_user_id, name, agreed_at, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      WS,
      ME,
      user,
      name,
      agreed,
      n,
    );
  contact('c1', MATE, 'Marcus Lee', null, 1);
  contact('c2', GONE, 'Former Teammate', null, 2);
  contact('c3', null, 'Dana Ruiz', '2026-09-01T00:00:00.000Z', 3);
  contact('c4', null, 'Not Yet', null, 4);
  put(
    'INSERT INTO workspace_memberships (id, workspace_id, user_id) VALUES (?, ?, ?)',
    'm1',
    WS,
    MATE,
  );
  // Makes the change as the phone does: its rows in one transaction, once per command id.
  const made = new Set<string>();
  const make = async (_name: string, _input: unknown, o: ChangeOptions = {}) => {
    if (o.commandId && made.has(o.commandId)) return { id: 'again' };
    if (o.commandId) made.add(o.commandId);
    await db.writeTransaction(async (tx) => o.optimistic?.(tx));
    return { id: 'change' };
  };
  const checkIn = () =>
    db.rows<{ planned_end_at: string; state: string; extended_count: number }>(
      'SELECT planned_end_at, state, extended_count FROM safety_checkins WHERE id = ?',
      [CHECK_IN],
    )[0]!;
  return { make: make as never, checkIn };
}

beforeEach(() => {
  (Notifications as unknown as { __presented: unknown[] }).__presented.length = 0;
});

describe('the check-in reminder’s buttons, with no signal', () => {
  it('+15 min moves the check-in and sets the reminder again, saying what the server would', async () => {
    const p = phone({ safety: { askAfterMinutes: 5, alertAfterMinutes: 20 } });
    await changeFromPress(
      'safety.extend',
      { workspaceId: WS, checkInId: CHECK_IN, minutes: 15 },
      { commandId: 'press-1', madeAt: PRESSED },
      p.make,
    );
    // Past its planned end, so fifteen minutes from the press; asked again five minutes after that.
    expect(p.checkIn()).toEqual({
      planned_end_at: '2026-10-01T21:50:00.000Z',
      state: 'in',
      extended_count: 1,
    });
    const [reminder] = scheduled();
    expect(reminder?.trigger.date).toEqual(new Date('2026-10-01T21:55:00.000Z'));
    expect(reminder?.content.body).toBe(
      'You planned to check out at 4:50 PM. If you don’t answer in 20 minutes, Marcus and Dana are told.',
    );

    // The same press heard again moves nothing.
    await changeFromPress(
      'safety.extend',
      { workspaceId: WS, checkInId: CHECK_IN, minutes: 15 },
      { commandId: 'press-1', madeAt: PRESSED },
      p.make,
    );
    expect(p.checkIn().extended_count).toBe(1);
    expect(scheduled()).toHaveLength(1);
  });

  it('uses the business’s own times when its settings say nothing', async () => {
    const p = phone({});
    await changeFromPress(
      'safety.extend',
      { workspaceId: WS, checkInId: CHECK_IN, minutes: 15 },
      { madeAt: PRESSED },
      p.make,
    );
    const [reminder] = scheduled();
    expect(reminder?.trigger.date).toEqual(new Date('2026-10-01T21:50:00.000Z'));
    expect(reminder?.content.body).toMatch(/answer in 10 minutes/);
  });

  it('I’m OK checks out on this phone and clears the reminder', async () => {
    const p = phone({});
    await changeFromPress(
      'safety.extend',
      { workspaceId: WS, checkInId: CHECK_IN, minutes: 15 },
      { madeAt: PRESSED },
      p.make,
    );
    expect(scheduled()).toHaveLength(1);
    await changeFromPress(
      'safety.check_out',
      { workspaceId: WS, checkInId: CHECK_IN },
      { madeAt: PRESSED + 60_000 },
      p.make,
    );
    expect(p.checkIn().state).toBe('out');
    expect(scheduled()).toHaveLength(0);

    // Time added to a check-in that's over sets nothing.
    await changeFromPress(
      'safety.extend',
      { workspaceId: WS, checkInId: CHECK_IN, minutes: 15 },
      { madeAt: PRESSED + 120_000 },
      p.make,
    );
    expect(p.checkIn()).toMatchObject({ state: 'out', extended_count: 1 });
    expect(scheduled()).toHaveLength(0);
  });
});
