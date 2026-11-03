/**
 * One person on several calendars: a booking on any of them takes that time on all the others, and a calendar
 * with other people still offers it with whoever is free. In one business, and across the businesses someone
 * works in, where the other business learns only that they're busy then.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import { as, asService, closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointmentCreate, calendarAvailability, scheduleSet, scheduleTeam } from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  setupTeam,
  warningCodes,
  WEEKDAYS,
  type Team,
} from './calendar-helpers';

let t: Team;
/** Another business, which Priya works in too. */
let u: Team;
beforeAll(async () => {
  t = await setupTeam('calshare');
  u = await setupTeam('calshare2');
  await rows(
    admin(),
    sql`insert into app.workspace_memberships (workspace_id, user_id, role) values (${u.wsId}, ${t.priya.id}, 'member')`,
  );
  await run(scheduleSet, { workspaceId: u.wsId, ownerId: t.priya.id, weekly: WEEKDAYS }, u.owner);
});
afterAll(closeTestDbs);

/** Each start time that day with the people free then. */
const openOn = async (calendarId: string, day: string, b: Team = t) => {
  const { slots } = await ask(
    calendarAvailability,
    { workspaceId: b.wsId, calendarId, from: isoAt(day, '00:00'), to: isoAt(day, '23:59') },
    b.owner,
  );
  return new Map(slots.map((s) => [s.startsAt, [...s.userIds].sort()]));
};

/** When the business's calendar shows someone booked in their other businesses that day. */
const elsewhereOn = async (b: Team, userId: string, day: string) =>
  (
    await ask(
      scheduleTeam,
      {
        workspaceId: b.wsId,
        from: isoAt(day, '00:00'),
        to: isoAt(day, '23:59'),
        userIds: [userId],
      },
      b.owner,
    )
  ).people[0]!.elsewhereBusy;

describe('in one business', () => {
  it('a booking on one calendar takes that time on every other calendar the person is on', async () => {
    const day = nextWeekday(2);
    const P = t.priya.id;
    const M = t.marco.id;
    const visits = await makeCalendar(t, 'Priya’s visits', {
      public: true,
      team: { members: [{ userId: P }], assignment: 'fixed' },
    });
    const calls = await makeCalendar(t, 'Priya’s calls', {
      public: true,
      team: { members: [{ userId: P }], assignment: 'fixed' },
    });
    const team = await makeCalendar(t, 'Team visits', {
      public: true,
      team: { members: [{ userId: P }, { userId: M }], assignment: 'round_robin' },
    });
    const together = await makeCalendar(t, 'Both of us', {
      public: true,
      team: { members: [{ userId: P }, { userId: M }], assignment: 'collective' },
    });

    const before = await openOn(team.id, day);
    expect(before.get(isoAt(day, '10:00'))).toEqual([P, M].sort());

    // A customer books Priya on her visits calendar from 10 to 11.
    expect((await bookOnline(t, visits.id, isoAt(day, '10:00'))).userIds).toEqual([P]);

    // Her other calendar no longer offers anything that overlaps it, and keeps the rest.
    const callTimes = await openOn(calls.id, day);
    for (const clock of ['09:30', '10:00', '10:30'])
      expect(callTimes.has(isoAt(day, clock))).toBe(false);
    for (const clock of ['09:00', '11:00']) expect(callTimes.get(isoAt(day, clock))).toEqual([P]);
    await expectHfos(() => bookOnline(t, calls.id, isoAt(day, '10:00')), 'slot_taken', 409);

    // A calendar she shares still offers 10:00, with Marco only; one that needs both of them doesn't.
    expect((await openOn(team.id, day)).get(isoAt(day, '10:00'))).toEqual([M]);
    expect((await openOn(together.id, day)).has(isoAt(day, '10:00'))).toBe(false);
    expect((await bookOnline(t, team.id, isoAt(day, '10:00'))).userIds).toEqual([M]);

    // Now both are taken at 10:00, so the shared calendar has nobody left then.
    expect((await openOn(team.id, day)).has(isoAt(day, '10:00'))).toBe(false);
    expect((await openOn(team.id, day)).get(isoAt(day, '11:00'))).toEqual([P, M].sort());
    // None of it counts as another business.
    expect(await elsewhereOn(t, P, day)).toEqual([]);
  });

  it('a booking made by hand counts on the person’s other calendars too', async () => {
    const day = nextWeekday(3);
    const P = t.priya.id;
    const M = t.marco.id;
    const office = await makeCalendar(t, 'Office', {
      team: { members: [{ userId: P }], assignment: 'fixed' },
    });
    const online = await makeCalendar(t, 'Online booking', {
      public: true,
      team: { members: [{ userId: P }, { userId: M }], assignment: 'first_available' },
    });
    await run(
      appointmentCreate,
      { workspaceId: t.wsId, calendarId: office.id, startsAt: isoAt(day, '14:00'), userIds: [P] },
      t.owner,
    );
    const open = await openOn(online.id, day);
    expect(open.get(isoAt(day, '13:00'))).toEqual([P, M].sort());
    expect(open.get(isoAt(day, '14:00'))).toEqual([M]);
    // First available would pick Priya, but she's busy then, so Marco gets it.
    expect((await bookOnline(t, online.id, isoAt(day, '14:00'))).userIds).toEqual([M]);
  });
});

describe('across the businesses someone works in', () => {
  it('a booking in one business takes that time in their other one, which sees only that they’re busy', async () => {
    const day = nextWeekday(4);
    const P = t.priya.id;
    const M = u.marco.id;
    const here = await makeCalendar(t, 'Priya’s visits here', {
      public: true,
      team: { members: [{ userId: P }], assignment: 'fixed' },
      buffers: { after: 15 },
    });
    const there = await makeCalendar(u, 'Priya’s visits there', {
      public: true,
      team: { members: [{ userId: P }], assignment: 'fixed' },
    });
    const shared = await makeCalendar(u, 'Their team', {
      public: true,
      team: { members: [{ userId: P }, { userId: M }], assignment: 'round_robin' },
    });

    expect((await bookOnline(t, here.id, isoAt(day, '10:00'))).userIds).toEqual([P]);

    // In the other business, nothing of hers overlaps 10 to 11:15 (the visit and its cleanup).
    const open = await openOn(there.id, day, u);
    for (const clock of ['09:30', '10:00', '10:30', '11:00'])
      expect(open.has(isoAt(day, clock))).toBe(false);
    for (const clock of ['09:00', '11:30']) expect(open.get(isoAt(day, clock))).toEqual([P]);
    await expectHfos(() => bookOnline(u, there.id, isoAt(day, '10:00')), 'slot_taken', 409);

    // Its shared calendar still offers 10:00, with Marco.
    expect((await openOn(shared.id, day, u)).get(isoAt(day, '10:00'))).toEqual([M]);
    expect((await bookOnline(u, shared.id, isoAt(day, '10:00'))).userIds).toEqual([M]);

    // Its calendar shows her busy then, and nothing of the appointment itself.
    expect(await elsewhereOn(u, P, day)).toEqual([
      { startsAt: isoAt(day, '10:00'), endsAt: isoAt(day, '11:15') },
    ]);
    const seen = await as(u.owner)((tx) =>
      rows(tx, sql`select id from app.appointments where calendar_id = ${here.id}`),
    );
    expect(seen).toEqual([]);

    // Booking her there by hand warns first, as a Google busy time does, and can go ahead.
    const book = (extra: Record<string, unknown> = {}) =>
      run(
        appointmentCreate,
        {
          workspaceId: u.wsId,
          calendarId: there.id,
          startsAt: isoAt(day, '10:30'),
          userIds: [P],
          ...extra,
        },
        u.owner,
      );
    const asked = await expectHfos(() => book(), 'needs_confirmation', 409);
    expect(warningCodes(asked)).toEqual(['booked_elsewhere']);
    expect(asked.message).toContain('Priya Tech is booked in another business then');
    await book({ acknowledgeWarnings: true });
    // The first business then sees that one the same way.
    expect(await elsewhereOn(t, P, day)).toEqual([
      { startsAt: isoAt(day, '10:30'), endsAt: isoAt(day, '11:30') },
    ]);
  });

  it('tells a business only about its own people, and only to someone who can open it', async () => {
    const day = nextWeekday(5);
    const from = isoAt(day, '00:00');
    const to = isoAt(day, '23:59');
    for (const [userId, name] of [
      [t.marco.id, 'Marco'],
      [t.priya.id, 'Priya'],
    ] as const) {
      const cal = await makeCalendar(t, `${name} at nine`, {
        public: true,
        team: { members: [{ userId }], assignment: 'fixed' },
      });
      await bookOnline(t, cal.id, isoAt(day, '09:00'));
    }
    const busy = (wsId: string, userId: string) => (tx: Tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from private.busy_elsewhere(${wsId}, array[${userId}::uuid], ${from}::timestamptz, ${to}::timestamptz)`,
      );
    // Marco doesn't work in the other business, so it hears nothing about him.
    expect(await as(u.owner)(busy(u.wsId, t.marco.id))).toEqual([]);
    expect(await asService(u.scope)(busy(u.wsId, t.marco.id))).toEqual([]);
    // Someone who can't open that business can't ask on its behalf, nor can the worker working for another.
    expect(await as(t.marco)(busy(u.wsId, t.priya.id))).toEqual([]);
    expect(await asService(t.scope)(busy(u.wsId, t.priya.id))).toEqual([]);
    // Those who can, and the worker working for it, hear that Priya is busy.
    expect(await as(u.owner)(busy(u.wsId, t.priya.id))).toEqual([{ user_id: t.priya.id }]);
    expect(await asService(u.scope)(busy(u.wsId, t.priya.id))).toEqual([{ user_id: t.priya.id }]);
  });
});
