/**
 * Availability on real data (round robin, weighted, collective, resources, seats, sessions, territory,
 * notice) and a daylight-saving cross-check of the TypeScript zone helpers against private.expand_schedule.
 */
import { rows, sql } from '@hfos/db/client';
import { as, closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addDays,
  expandWeeklyHours,
  intervals,
  parseLocalDate,
  weekdayOf,
  zonedTime,
  type WeeklyHours,
} from '../src/calendar/index';
import {
  calendarAvailability,
  resourceCreate,
  scheduleSet,
  sessionPublish,
  territoryCreate,
  timeOffAdd,
} from '../src/server';
import {
  admin,
  ask,
  at,
  bookOnline,
  CHI,
  DAY,
  isoAt,
  makeCalendar,
  MIN,
  nextWeekday,
  run,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
beforeAll(async () => {
  t = await setupTeam('calavail');
});
afterAll(closeTestDbs);

const slotsOn = async (
  calendarId: string,
  from: string,
  to: string,
  extra: Record<string, unknown> = {},
) =>
  (
    await ask(
      calendarAvailability,
      { workspaceId: t.wsId, calendarId, from, to, ...extra },
      t.owner,
    )
  ).slots;
const starts = (slots: { startsAt: string }[]) => slots.map((s) => s.startsAt);

describe('availability on real data', () => {
  it('round robin rotates to whoever was assigned least recently', async () => {
    const day = nextWeekday(2);
    const cal = await makeCalendar(t, 'Rotation', {
      public: true,
      team: {
        members: [{ userId: t.priya.id }, { userId: t.marco.id }],
        assignment: 'round_robin',
      },
    });
    const slots = await slotsOn(cal.id, isoAt(day, '00:00'), isoAt(addDays(day, 1), '00:00'));
    expect(slots[0]).toMatchObject({
      startsAt: isoAt(day, '08:00'),
      endsAt: isoAt(day, '09:00'),
      userIds: [t.priya.id, t.marco.id],
      sessionId: null,
    });
    expect(slots.at(-1)!.startsAt).toBe(isoAt(day, '16:00'));
    const picks: string[] = [];
    for (const clock of ['08:00', '10:00', '12:00', '14:00'])
      picks.push((await bookOnline(t, cal.id, isoAt(day, clock))).userIds[0]!);
    expect(picks).toEqual([t.priya.id, t.marco.id, t.priya.id, t.marco.id]);
    const state = await rows<{ user_id: string; assigned_count: number }>(
      admin(),
      sql`select user_id, assigned_count from app.calendar_assignment_state where calendar_id = ${cal.id}`,
    );
    expect(state.map((s) => s.assigned_count)).toEqual([2, 2]);
  });

  it('weighted round robin shares bookings by weight', async () => {
    const day = nextWeekday(3);
    const cal = await makeCalendar(t, 'Weighted', {
      public: true,
      team: {
        members: [
          { userId: t.priya.id, weight: 3 },
          { userId: t.marco.id, weight: 1 },
        ],
        assignment: 'weighted',
      },
    });
    const picks: string[] = [];
    for (const clock of ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'])
      picks.push((await bookOnline(t, cal.id, isoAt(day, clock))).userIds[0]!);
    const P = t.priya.id;
    const M = t.marco.id;
    expect(picks).toEqual([P, P, M, P, P, P, M, P]);
  });

  it('collective needs everyone free at once', async () => {
    const day = nextWeekday(4);
    await run(
      timeOffAdd,
      {
        workspaceId: t.wsId,
        ownerId: t.marco.id,
        startsAt: isoAt(day, '12:00'),
        endsAt: isoAt(day, '13:00'),
      },
      t.owner,
    );
    const cal = await makeCalendar(t, 'Together', {
      public: true,
      team: {
        members: [
          { userId: t.priya.id, required: true },
          { userId: t.marco.id, required: true },
        ],
        assignment: 'collective',
      },
    });
    const open = starts(await slotsOn(cal.id, isoAt(day, '08:00'), isoAt(day, '17:00')));
    expect(open).toContain(isoAt(day, '11:00'));
    expect(open).not.toContain(isoAt(day, '11:30'));
    expect(open).not.toContain(isoAt(day, '12:00'));
    expect(open).toContain(isoAt(day, '13:00'));
    const booked = await bookOnline(t, cal.id, isoAt(day, '10:00'));
    expect([...booked.userIds].sort()).toEqual([t.priya.id, t.marco.id].sort());
    const staff = await rows(
      admin(),
      sql`select user_id from app.appointment_staff where appointment_id = ${booked.appointmentId}`,
    );
    expect(staff).toHaveLength(2);
  });

  it('a required resource limits bookings to its quantity', async () => {
    const day = nextWeekday(5);
    const lift = await run(
      resourceCreate,
      { workspaceId: t.wsId, name: 'Lift', quantity: 1 },
      t.owner,
    );
    const cal = await makeCalendar(t, 'Lift jobs', {
      public: true,
      team: {
        members: [{ userId: t.priya.id }, { userId: t.marco.id }],
        assignment: 'round_robin',
      },
      resources: { required: [{ resourceId: lift.resourceId }] },
    });
    await bookOnline(t, cal.id, isoAt(day, '10:00'));
    const open = starts(await slotsOn(cal.id, isoAt(day, '08:00'), isoAt(day, '17:00')));
    // Marco is still free, but the lift is out.
    expect(open).not.toContain(isoAt(day, '10:00'));
    expect(open).not.toContain(isoAt(day, '10:30'));
    expect(open).toContain(isoAt(day, '09:00'));
    expect(open).toContain(isoAt(day, '11:00'));
  });

  it('seats: later customers join the open group time until it is full', async () => {
    const day = nextWeekday(1);
    const cal = await makeCalendar(t, 'Small class', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
      capacity: { seats: 3, maxPartySize: 2 },
    });
    const first = await bookOnline(t, cal.id, isoAt(day, '09:00'), { partySize: 2 });
    expect(first.joined).toBe(false);
    const nine = (await slotsOn(cal.id, isoAt(day, '09:00'), isoAt(day, '09:01')))[0];
    expect(nine).toMatchObject({ sessionId: first.appointmentId, seatsLeft: 1 });
    const join = await bookOnline(t, cal.id, isoAt(day, '09:00'), {
      sessionId: first.appointmentId,
    });
    expect(join).toMatchObject({ joined: true, appointmentId: first.appointmentId });
    expect(await slotsOn(cal.id, isoAt(day, '09:00'), isoAt(day, '09:01'))).toEqual([]);
    const [row] = await rows<{ seats_taken: number; capacity: number }>(
      admin(),
      sql`select seats_taken, capacity from app.appointments where id = ${first.appointmentId}`,
    );
    expect(row).toEqual({ seats_taken: 3, capacity: 3 });
  });

  it('sessions: published dates with the seats left', async () => {
    const day = nextWeekday(3, 10);
    const cal = await makeCalendar(t, 'Workshop', {
      public: true,
      team: { members: [{ userId: t.owner.id }] },
      schedule: { mode: 'sessions' },
      capacity: { seats: 5, maxPartySize: 2 },
    });
    const published = await run(
      sessionPublish,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        startsAt: isoAt(day, '18:00'),
        userIds: [t.owner.id],
        acknowledgeWarnings: true,
      },
      t.owner,
    );
    expect(published.warnings.map((w) => w.code)).toEqual(['outside_hours']);
    expect(published.capacity).toBe(5);
    const whole = [isoAt(day, '00:00'), isoAt(addDays(day, 1), '00:00')] as const;
    expect(await slotsOn(cal.id, ...whole)).toEqual([
      expect.objectContaining({
        startsAt: isoAt(day, '18:00'),
        sessionId: published.appointmentId,
        seatsLeft: 5,
      }),
    ]);
    await bookOnline(t, cal.id, isoAt(day, '18:00'), {
      sessionId: published.appointmentId,
      partySize: 2,
    });
    expect((await slotsOn(cal.id, ...whole))[0]!.seatsLeft).toBe(3);
  });

  it('routes by ZIP to the people who cover it, with travel on both sides', async () => {
    const day = nextWeekday(2, 10);
    await run(
      territoryCreate,
      { workspaceId: t.wsId, name: 'North', postalCodes: ['75201'], userIds: [t.priya.id] },
      t.owner,
    );
    await run(
      territoryCreate,
      { workspaceId: t.wsId, name: 'South', postalCodes: ['75215'], userIds: [t.marco.id] },
      t.owner,
    );
    const cal = await makeCalendar(t, 'Dispatch', {
      public: true,
      team: {
        members: [{ userId: t.priya.id }, { userId: t.marco.id }],
        assignment: 'round_robin',
      },
      territory: { routing: 'zip' },
      locations: { options: [{ kind: 'customer_address' }] },
      buffers: { travelMinutes: 30 },
    });
    const at10 = (postalCode: string) =>
      slotsOn(cal.id, isoAt(day, '10:00'), isoAt(day, '10:01'), { postalCode });
    expect((await at10('75215'))[0]!.userIds).toEqual([t.marco.id]);
    expect((await at10('75201-1234'))[0]!.userIds).toEqual([t.priya.id]);
    expect(await at10('99999')).toEqual([]);
    const booked = await bookOnline(t, cal.id, isoAt(day, '10:00'), {
      postalCode: '75215',
      address: '1 Main St',
    });
    expect(booked.userIds).toEqual([t.marco.id]);
    const south = starts(
      await slotsOn(cal.id, isoAt(day, '08:00'), isoAt(day, '17:00'), { postalCode: '75215' }),
    );
    expect(south).not.toContain(isoAt(day, '11:00'));
    expect(south).toContain(isoAt(day, '11:30'));
    expect(south).toContain(isoAt(day, '08:30'));
    expect(south).not.toContain(isoAt(day, '09:00'));
    const [appt] = await rows<{ buffer_before: number; buffer_after: number; location: object }>(
      admin(),
      sql`select buffer_before, buffer_after, location from app.appointments where id = ${booked.appointmentId}`,
    );
    expect(appt).toMatchObject({
      buffer_before: 30,
      buffer_after: 30,
      location: { kind: 'customer_address', address: '1 Main St', postalCode: '75215' },
    });
  });

  it('applies minimum notice from the database clock', async () => {
    const cal = await makeCalendar(t, 'Notice', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
      window: { minNoticeMinutes: 2880 },
    });
    const now = Date.now();
    const slots = await slotsOn(
      cal.id,
      new Date(now).toISOString(),
      new Date(now + 10 * DAY).toISOString(),
    );
    expect(slots.length).toBeGreaterThan(0);
    const first = Math.min(...slots.map((s) => Date.parse(s.startsAt)));
    expect(first).toBeGreaterThanOrEqual(now + 2880 * MIN - 60_000);
  });
});

describe('daylight saving: zonedTime against private.expand_schedule (America/Chicago)', () => {
  const weekly: WeeklyHours = [
    { day: 0, start: '00:00', end: '24:00' },
    { day: 0, start: '01:30', end: '03:00' },
    { day: 0, start: '02:30', end: '03:30' },
    { day: 0, start: '09:00', end: '17:00' },
    { day: 1, start: '09:00', end: '17:00' },
    { day: 6, start: '22:00', end: '24:00' },
  ];
  /** A local wall time through zonedTime ('24:00' is the next day's midnight). */
  const wall = (date: string, clock: string) => {
    const d = parseLocalDate(clock === '24:00' ? addDays(date, 1) : date);
    const [h, m] = (clock === '24:00' ? '00:00' : clock).split(':').map(Number);
    return zonedTime(d.year, d.month, d.day, h!, m!, CHI).getTime();
  };
  const byStart = (a: { s: number; e: number }, b: { s: number; e: number }) =>
    a.s - b.s || a.e - b.e;

  it.each([
    ['2026-03-08', 23, 30],
    ['2026-11-01', 25, 90],
  ])('agrees on %s (a %i-hour day)', async (sunday, hours, earlyMinutes) => {
    const resource = await run(
      resourceCreate,
      { workspaceId: t.wsId, name: `DST ${sunday}` },
      t.owner,
    );
    const { scheduleId } = await run(
      scheduleSet,
      {
        workspaceId: t.wsId,
        ownerKind: 'resource',
        ownerId: resource.resourceId,
        timezone: CHI,
        weekly,
      },
      t.owner,
    );
    const from = at(addDays(sunday, -1), '00:00');
    const to = at(addDays(sunday, 2), '00:00');
    const fromDb = await as(t.owner)((tx) =>
      rows<{ s: number; e: number }>(
        tx,
        sql`select round(extract(epoch from starts_at) * 1000)::float8 as s,
                   round(extract(epoch from ends_at) * 1000)::float8 as e
            from private.expand_schedule(${scheduleId}::uuid, ${new Date(from).toISOString()}::timestamptz,
                                         ${new Date(to).toISOString()}::timestamptz)`,
      ),
    );
    const expected: { s: number; e: number }[] = [];
    for (let date = addDays(sunday, -1); date < addDays(sunday, 2); date = addDays(date, 1))
      for (const w of weekly)
        if (w.day === weekdayOf(date))
          expected.push({ s: wall(date, w.start), e: wall(date, w.end) });
    expect([...fromDb].sort(byStart)).toEqual(expected.sort(byStart));
    // The engine's TypeScript mirror agrees too, once merged.
    expect(intervals.normalize(fromDb.map((r) => ({ start: r.s, end: r.e })))).toEqual(
      expandWeeklyHours(weekly, from, to, CHI),
    );
    // The whole day, and 01:30 to 03:00 across the change.
    const day = fromDb.find((r) => r.s === wall(sunday, '00:00') && r.e === wall(sunday, '24:00'))!;
    expect((day.e - day.s) / 3_600_000).toBe(hours);
    const early = fromDb.find((r) => r.s === wall(sunday, '01:30'))!;
    expect((early.e - early.s) / MIN).toBe(earlyMinutes);
    if (sunday === '2026-03-08') {
      // 2:30 AM never happens: read an hour later on the clock, so 2:30 to 3:30 is empty.
      expect(early.s).toBe(Date.parse('2026-03-08T07:30:00Z'));
      expect(fromDb).toContainEqual({
        s: Date.parse('2026-03-08T08:30:00Z'),
        e: Date.parse('2026-03-08T08:30:00Z'),
      });
    } else {
      // 1:30 AM happens twice: the second one (CST).
      expect(early.s).toBe(Date.parse('2026-11-01T07:30:00Z'));
      expect(fromDb).toContainEqual({
        s: Date.parse('2026-11-01T08:30:00Z'),
        e: Date.parse('2026-11-01T09:30:00Z'),
      });
    }
  });
});
