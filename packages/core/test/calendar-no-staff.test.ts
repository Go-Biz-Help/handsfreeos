/**
 * Calendars with no staff on the local database: a bed booked online and by staff with no staff rows, the
 * calendar's owner answering for it, resource_full with nearby times (no booking anyway past a physical limit),
 * people picked by hand refused, moving, cancelling and handing over, sessions and repeats, and the queries.
 */
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/calendar/index';
import type { SlotOut } from '../src/schemas/calendar';
import {
  appointmentCancel,
  appointmentCreate,
  appointmentGet,
  appointmentList,
  appointmentReassign,
  appointmentReschedule,
  attendeeCancelOnline,
  attendeeRescheduleOnline,
  calendarAvailability,
  resourceCreate,
  seriesCreate,
  sessionPublish,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  customer,
  expectHfos,
  isoAt,
  makeCalendar,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let bed: string;
let beds: Awaited<ReturnType<typeof makeCalendar>>;
const OPEN = [1, 2, 3, 4, 5].map((day) => ({ day, start: '07:00', end: '20:00' }));

beforeAll(async () => {
  t = await setupTeam('calnostaff');
  bed = (
    await run(
      resourceCreate,
      { workspaceId: t.wsId, name: 'Red light bed', kind: 'equipment', quantity: 4 },
      t.owner,
    )
  ).resourceId;
  beds = await makeCalendar(t, 'Book a bed', {
    public: true,
    team: { members: [], assignment: 'none' },
    resources: { required: [{ resourceId: bed }] },
    durations: { minutes: [20], step: 10 },
    buffers: { after: 10 },
    schedule: { hours: OPEN },
  });
});
afterAll(closeTestDbs);

const book = (input: Record<string, unknown>) =>
  run(appointmentCreate, { workspaceId: t.wsId, calendarId: beds.id, ...input }, t.owner);
const staffRows = async (appointmentId: string) =>
  (
    await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.appointment_staff where appointment_id = ${appointmentId}`,
    )
  )[0]!.n;
const startsOf = (slots: readonly SlotOut[]) => slots.map((s) => s.startsAt);

describe('booking a bed', () => {
  it('books online and by staff with no staff rows, and the calendar’s owner answers for it', async () => {
    const day = nextWeekday(2);
    const online = await bookOnline(t, beds.id, isoAt(day, '09:00'));
    expect(online.userIds).toEqual([]);
    expect(await staffRows(online.appointmentId)).toBe(0);

    const maria = await customer(t, 'Maria');
    const staff = await run(
      appointmentCreate,
      { workspaceId: t.wsId, calendarId: beds.id, startsAt: isoAt(day, '09:10'), personId: maria },
      t.member,
    );
    expect(staff).toMatchObject({ userIds: [], warnings: [] });
    expect(await staffRows(staff.appointmentId)).toBe(0);
    const [row] = await rows<{ owner_user_id: string; quantity: number }>(
      admin(),
      sql`select a.owner_user_id, r.quantity from app.appointments a
          join app.appointment_resources r on r.appointment_id = a.id where a.id = ${staff.appointmentId}`,
    );
    expect(row).toEqual({ owner_user_id: t.owner.id, quantity: 1 });

    const { appointment } = await ask(
      appointmentGet,
      { workspaceId: t.wsId, appointmentId: staff.appointmentId },
      t.member,
    );
    expect(appointment).toMatchObject({
      staff: [],
      resources: [{ resourceId: bed, name: 'Red light bed', quantity: 1 }],
    });
  });

  it('refuses people picked by hand with a clear 400', async () => {
    const e = await expectHfos(
      () => book({ startsAt: isoAt(nextWeekday(2), '12:00'), userIds: [t.priya.id] }),
      'validation',
      400,
    );
    expect(e.message).toBe('This calendar books without staff. Leave out who works it.');
    expect(e.details).toEqual([
      { path: 'userIds', message: 'This calendar books without staff. Leave out who works it.' },
    ]);
  });

  it('stops at four beds with resource_full and nearby times, for staff (even anyway) and customers', async () => {
    const day = nextWeekday(3);
    const ten = isoAt(day, '10:00');
    for (let i = 0; i < 4; i++) await book({ startsAt: ten });

    const staff = await expectHfos(
      () => book({ startsAt: ten, acknowledgeWarnings: true }),
      'resource_full',
      409,
    );
    expect(staff.message).toBe('No Red light bed is free then.');
    const details = staff.details as { resourceId: string; slots: SlotOut[] };
    expect(details.resourceId).toBe(bed);
    expect(startsOf(details.slots)).not.toContain(ten);
    // The nearest free starts: 09:30 (its cleanup ends as they start) and 10:30 (after theirs).
    expect(startsOf(details.slots)).toEqual(
      expect.arrayContaining([isoAt(day, '09:30'), isoAt(day, '10:30')]),
    );
    expect(details.slots.every((s) => s.userIds.length === 0)).toBe(true);

    // While the beds are being cleaned, still no.
    await expectHfos(
      () => book({ startsAt: isoAt(day, '10:20'), acknowledgeWarnings: true }),
      'resource_full',
      409,
    );

    const online = await expectHfos(() => bookOnline(t, beds.id, ten), 'resource_full', 409);
    expect(online.message).toBe('No Red light bed is free then.');
    expect((online.details as { slots: SlotOut[] }).slots.length).toBeGreaterThan(0);

    const open = await ask(
      calendarAvailability,
      {
        workspaceId: t.wsId,
        calendarId: beds.id,
        from: isoAt(day, '09:00'),
        to: isoAt(day, '11:00'),
      },
      t.owner,
    );
    const starts = startsOf(open.slots);
    expect(starts).not.toContain(ten);
    expect(starts).not.toContain(isoAt(day, '10:20'));
    expect(starts).toContain(isoAt(day, '10:30'));
    expect(open.slots.every((s) => s.userIds.length === 0)).toBe(true);
  });

  it('moves and cancels a booking, and has nobody to hand it to', async () => {
    const day = nextWeekday(4);
    const two = isoAt(day, '14:00');
    const four: string[] = [];
    for (let i = 0; i < 4; i++) four.push((await book({ startsAt: two })).appointmentId);
    const mine = await book({ startsAt: isoAt(day, '15:00') });

    await expectHfos(
      () =>
        run(
          appointmentReschedule,
          {
            workspaceId: t.wsId,
            appointmentId: mine.appointmentId,
            startsAt: two,
            acknowledgeWarnings: true,
          },
          t.owner,
        ),
      'resource_full',
      409,
    );
    const moved = await run(
      appointmentReschedule,
      { workspaceId: t.wsId, appointmentId: mine.appointmentId, startsAt: isoAt(day, '16:00') },
      t.owner,
    );
    expect(moved).toMatchObject({
      startsAt: isoAt(day, '16:00'),
      endsAt: isoAt(day, '16:20'),
      warnings: [],
    });
    await expectHfos(
      () =>
        run(
          appointmentReassign,
          { workspaceId: t.wsId, appointmentId: mine.appointmentId, userIds: [t.priya.id] },
          t.owner,
        ),
      'calendar_has_no_staff',
      409,
    );

    // One of the four gives up its bed, and 14:00 takes a booking again.
    await run(appointmentCancel, { workspaceId: t.wsId, appointmentId: four[0]! }, t.owner);
    expect((await book({ startsAt: two })).userIds).toEqual([]);
  });

  it('lets a customer move and cancel their bed online', async () => {
    const day = nextWeekday(5);
    const booked = await bookOnline(t, beds.id, isoAt(day, '08:00'));
    const moved = await runSystem(
      attendeeRescheduleOnline,
      {
        workspaceId: t.wsId,
        attendeeId: booked.attendeeId,
        manageVersion: booked.manageVersion,
        startsAt: isoAt(day, '09:00'),
      },
      t.scope,
    );
    expect(moved).toMatchObject({
      appointmentId: booked.appointmentId,
      startsAt: isoAt(day, '09:00'),
    });
    expect(await staffRows(booked.appointmentId)).toBe(0);

    for (let i = 0; i < 4; i++) await book({ startsAt: isoAt(day, '11:00') });
    await expectHfos(
      () =>
        runSystem(
          attendeeRescheduleOnline,
          {
            workspaceId: t.wsId,
            attendeeId: booked.attendeeId,
            manageVersion: booked.manageVersion,
            startsAt: isoAt(day, '11:00'),
          },
          t.scope,
        ),
      'resource_full',
      409,
    );
    const cancelled = await runSystem(
      attendeeCancelOnline,
      { workspaceId: t.wsId, attendeeId: booked.attendeeId, manageVersion: booked.manageVersion },
      t.scope,
    );
    expect(cancelled.appointmentCancelled).toBe(true);
  });
});

describe('sessions, repeats and lists without staff', () => {
  it('publishes a session with nobody on it that customers join, and repeats a booking', async () => {
    const sauna = await makeCalendar(t, 'Open sauna', {
      public: true,
      team: { members: [], assignment: 'none' },
      schedule: { mode: 'sessions' },
      capacity: { seats: 6, maxPartySize: 2 },
    });
    const day = nextWeekday(2, 8);
    const session = await run(
      sessionPublish,
      { workspaceId: t.wsId, calendarId: sauna.id, startsAt: isoAt(day, '18:00') },
      t.owner,
    );
    expect(await staffRows(session.appointmentId)).toBe(0);
    for (let i = 0; i < 2; i++)
      await bookOnline(t, sauna.id, isoAt(day, '18:00'), { sessionId: session.appointmentId });
    const [held] = await rows<{ seats_taken: number }>(
      admin(),
      sql`select seats_taken from app.appointments where id = ${session.appointmentId}`,
    );
    expect(held!.seats_taken).toBe(2);

    const first = nextWeekday(3, 8);
    const series = await run(
      seriesCreate,
      {
        workspaceId: t.wsId,
        calendarId: beds.id,
        firstDate: first,
        rule: { freq: 'weekly', count: 3, localTime: '07:00' },
      },
      t.owner,
    );
    expect(series.appointmentIds).toHaveLength(3);
    for (const id of series.appointmentIds) expect(await staffRows(id)).toBe(0);
    await expectHfos(
      () =>
        run(
          seriesCreate,
          {
            workspaceId: t.wsId,
            calendarId: beds.id,
            firstDate: addDays(first, 1),
            rule: { freq: 'weekly', count: 2, localTime: '07:00' },
            userIds: [t.priya.id],
          },
          t.owner,
        ),
      'validation',
      400,
    );
  });

  it('lists a staffless appointment by calendar or resource, but not under anyone’s name', async () => {
    const day = nextWeekday(1, 10);
    const a = await book({ startsAt: isoAt(day, '09:00') });
    const range = { workspaceId: t.wsId, from: isoAt(day, '00:00'), to: isoAt(day, '23:00') };
    const byCalendar = await ask(appointmentList, { ...range, calendarIds: [beds.id] }, t.owner);
    expect(byCalendar.items.map((i) => i.id)).toEqual([a.appointmentId]);
    expect(byCalendar.items[0]!.staff).toEqual([]);
    const byResource = await ask(appointmentList, { ...range, resourceIds: [bed] }, t.owner);
    expect(byResource.items.map((i) => i.id)).toContain(a.appointmentId);
    const byPerson = await ask(appointmentList, { ...range, userIds: [t.owner.id] }, t.owner);
    expect(byPerson.items.map((i) => i.id)).not.toContain(a.appointmentId);
  });
});
