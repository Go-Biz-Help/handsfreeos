/**
 * Booking flows on the local database: staff warnings, the appointment lifecycle with timeline entries,
 * the booking page (customer matching, SMS consent, leads, manage links), series, sessions and waitlists.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localDateOf } from '../src/calendar/index';
import {
  appointmentAddAttendee,
  appointmentCancel,
  appointmentCreate,
  appointmentGet,
  appointmentReassign,
  appointmentRemoveAttendee,
  appointmentReschedule,
  appointmentSetStatus,
  appointmentUpdate,
  attendeeCancelOnline,
  attendeeRescheduleOnline,
  calendarSetStatus,
  leadCreate,
  pipelineList,
  seriesCancel,
  seriesCreate,
  sessionPublish,
  timeOffAdd,
  timelineList,
  waitlistAdd,
  waitlistRemove,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  CHI,
  customer,
  DAY,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  nextWeekday,
  run,
  runSystem,
  setupTeam,
  warningCodes,
  type Team,
} from './calendar-helpers';

let t: Team;
let visits: Awaited<ReturnType<typeof makeCalendar>>;
beforeAll(async () => {
  t = await setupTeam('calbook');
  visits = await makeCalendar(t, 'Visits', {
    public: true,
    team: { members: [{ userId: t.priya.id }, { userId: t.marco.id }], assignment: 'round_robin' },
    buffers: { after: 15 },
  });
});
afterAll(closeTestDbs);

const book = (input: Record<string, unknown>) =>
  run(appointmentCreate, { workspaceId: t.wsId, calendarId: visits.id, ...input }, t.owner);

describe('staff booking', () => {
  it('warns about hours, buffers, time off, busy calendars and the past, and never allows an overlap', async () => {
    const day = nextWeekday(2);
    const early = await expectHfos(
      () => book({ startsAt: isoAt(day, '07:00'), userIds: [t.priya.id] }),
      'needs_confirmation',
      409,
    );
    expect(warningCodes(early)).toEqual(['outside_hours']);
    const first = await book({
      startsAt: isoAt(day, '07:00'),
      userIds: [t.priya.id],
      acknowledgeWarnings: true,
    });
    expect(first.warnings.map((w) => w.code)).toEqual(['outside_hours']);

    const clash = await expectHfos(
      () => book({ startsAt: isoAt(day, '08:00'), userIds: [t.priya.id] }),
      'needs_confirmation',
    );
    expect(warningCodes(clash)).toEqual(['buffer_clash']);
    await expectHfos(
      () =>
        book({ startsAt: isoAt(day, '07:30'), userIds: [t.priya.id], acknowledgeWarnings: true }),
      'slot_taken',
      409,
    );

    await run(
      timeOffAdd,
      {
        workspaceId: t.wsId,
        ownerId: t.marco.id,
        startsAt: isoAt(day, '13:00'),
        endsAt: isoAt(day, '14:00'),
      },
      t.owner,
    );
    const off = await expectHfos(
      () => book({ startsAt: isoAt(day, '13:00'), userIds: [t.marco.id] }),
      'needs_confirmation',
    );
    expect(warningCodes(off)).toEqual(['time_off']);

    const [conn] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendar_connections (workspace_id, user_id, provider, status, created_by)
          values (${t.wsId}, ${t.marco.id}, 'google', 'active', ${t.marco.id}) returning id`,
    );
    await rows(
      admin(),
      sql`insert into app.calendar_busy_blocks (workspace_id, connection_id, user_id, starts_at, ends_at)
          values (${t.wsId}, ${conn!.id}, ${t.marco.id}, ${isoAt(day, '15:00')}::timestamptz,
                  ${isoAt(day, '16:00')}::timestamptz)`,
    );
    const busy = await expectHfos(
      () => book({ startsAt: isoAt(day, '15:00'), userIds: [t.marco.id] }),
      'needs_confirmation',
    );
    expect(warningCodes(busy)).toEqual(['calendar_busy']);

    const past = await expectHfos(
      () =>
        book({
          startsAt: new Date(Date.now() - DAY).toISOString(),
          userIds: [t.marco.id],
        }),
      'needs_confirmation',
    );
    expect(warningCodes(past)).toContain('in_past');

    // Letting the calendar choose passes over people with warnings: Marco is off at 13:00.
    const chosen = await book({ startsAt: isoAt(day, '13:00') });
    expect(chosen).toMatchObject({ userIds: [t.priya.id], warnings: [] });
  });

  it('books once per clientId, then moves, reassigns, completes, cancels and no-shows with timeline entries', async () => {
    const day = nextWeekday(3);
    const maria = await customer(t, 'Maria', nextPhone());
    const clientId = randomUUID();
    const input = {
      startsAt: isoAt(day, '09:00'),
      personId: maria,
      clientId,
      userIds: [t.priya.id],
    };
    const a = await book(input);
    expect(await book(input)).toMatchObject({ appointmentId: a.appointmentId, duplicate: true });
    const moved = await run(
      appointmentReschedule,
      { workspaceId: t.wsId, appointmentId: a.appointmentId, startsAt: isoAt(day, '11:00') },
      t.owner,
    );
    expect(moved).toMatchObject({ startsAt: isoAt(day, '11:00'), endsAt: isoAt(day, '12:00') });
    await run(
      appointmentReassign,
      { workspaceId: t.wsId, appointmentId: a.appointmentId, userIds: [t.marco.id] },
      t.owner,
    );
    await run(
      appointmentUpdate,
      { workspaceId: t.wsId, appointmentId: a.appointmentId, notes: 'Gate code 1234' },
      t.owner,
    );
    const { appointment } = await ask(
      appointmentGet,
      { workspaceId: t.wsId, appointmentId: a.appointmentId },
      t.member,
    );
    expect(appointment).toMatchObject({
      notes: 'Gate code 1234',
      staff: [{ userId: t.marco.id, fullName: 'Marco Tech', role: 'host' }],
      calendar: { id: visits.id, name: 'Visits' },
      bufferAfter: 15,
      createdBy: { id: t.owner.id },
    });
    expect(appointment.attendees[0]).toMatchObject({
      personId: maria,
      smsOk: true,
      source: 'staff',
    });
    await run(
      appointmentSetStatus,
      { workspaceId: t.wsId, appointmentId: a.appointmentId, status: 'completed' },
      t.owner,
    );

    const b = await book({ startsAt: isoAt(day, '14:00'), personId: maria });
    await run(
      appointmentCancel,
      { workspaceId: t.wsId, appointmentId: b.appointmentId, reason: 'Customer called' },
      t.owner,
    );
    const c = await book({ startsAt: isoAt(day, '16:00'), personId: maria });
    await run(
      appointmentSetStatus,
      { workspaceId: t.wsId, appointmentId: c.appointmentId, status: 'no_show' },
      t.owner,
    );

    const timeline = await ask(
      timelineList,
      { workspaceId: t.wsId, recordType: 'person', recordId: maria },
      t.owner,
    );
    const subtypes = timeline.items.map((i) => i.subtype);
    expect(subtypes).toEqual(
      expect.arrayContaining([
        'appointment_booked',
        'appointment_rescheduled',
        'appointment_completed',
        'appointment_cancelled',
        'appointment_no_show',
      ]),
    );
    const [audit] = await rows<{ after: Record<string, unknown> }>(
      admin(),
      sql`select after from app.audit_logs where entity_id = ${a.appointmentId} and action = 'appointment.create'`,
    );
    expect(audit!.after).toMatchObject({
      calendar: 'Visits',
      staff: ['Priya Tech'],
      customers: ['Maria Customer'],
    });
  });
});

describe('the booking page', () => {
  it('matches or creates the customer, never edits one, respects STOP and opens a lead', async () => {
    const { pipelines } = await ask(pipelineList, { workspaceId: t.wsId }, t.owner);
    const pipeline = pipelines[0]!;
    const stage = pipeline.stages.find((s) => s.kind === 'open')!;
    const online = await makeCalendar(t, 'Online', {
      public: true,
      team: { members: [{ userId: t.priya.id }] },
      crm: { createLead: { pipelineId: pipeline.id, stageId: stage.id } },
      intake: {
        questions: [{ id: 'unit', label: 'Which unit?', kind: 'short_text', required: true }],
      },
    });
    const day = nextWeekday(4);
    await expectHfos(() => bookOnline(t, online.id, isoAt(day, '09:00')), 'validation', 400);

    const phone = nextPhone();
    const first = await bookOnline(t, online.id, isoAt(day, '09:00'), {
      customer: { firstName: 'Nora', lastName: 'New', phone, email: 'Nora@Example.com' },
      smsConsent: true,
      intake: { unit: 'Attic' },
    });
    expect(first).toMatchObject({ personCreated: true, joined: false, userIds: [t.priya.id] });
    expect(first.leadId).not.toBeNull();
    const [person] = await rows<{ source: string; sms_consent: string; email: string }>(
      admin(),
      sql`select source, sms_consent::text as sms_consent, email::text as email from app.people where id = ${first.personId}`,
    );
    expect(person).toEqual({
      source: 'Booking page',
      sms_consent: 'opted_in',
      email: 'nora@example.com',
    });
    const [att] = await rows<{
      sms_ok: boolean;
      source: string;
      contact_phone_e164: string;
      intake: object;
    }>(
      admin(),
      sql`select sms_ok, source::text as source, contact_phone_e164, intake from app.appointment_attendees where id = ${first.attendeeId}`,
    );
    expect(att).toEqual({
      sms_ok: true,
      source: 'booking_page',
      contact_phone_e164: phone,
      intake: { unit: 'Attic' },
    });
    const [appt] = await rows<{ source: string; lead_id: string }>(
      admin(),
      sql`select source::text as source, lead_id from app.appointments where id = ${first.appointmentId}`,
    );
    expect(appt).toEqual({ source: 'booking_page', lead_id: first.leadId });
    const [activity] = await rows(
      admin(),
      sql`select id from app.activities where person_id = ${first.personId} and subtype = 'appointment_booked_online'`,
    );
    expect(activity).toBeDefined();

    // The same phone with another name: matched, never edited, and the open lead is reused.
    const second = await bookOnline(t, online.id, isoAt(day, '11:00'), {
      customer: { firstName: 'Someone', lastName: 'Else', phone },
      intake: { unit: 'Garage' },
    });
    expect(second).toMatchObject({
      personId: first.personId,
      personCreated: false,
      leadId: first.leadId,
    });
    const [still] = await rows<{ first_name: string }>(
      admin(),
      sql`select first_name from app.people where id = ${first.personId}`,
    );
    expect(still!.first_name).toBe('Nora');

    // A STOP on the number wins over the box.
    const stopped = nextPhone();
    await rows(
      admin(),
      sql`insert into app.opt_outs (workspace_id, counterpart_e164, opted_out, source)
          values (${t.wsId}, ${stopped}, true, 'keyword')`,
    );
    const third = await bookOnline(t, online.id, isoAt(day, '13:00'), {
      customer: { firstName: 'Stan', lastName: 'Stop', phone: stopped },
      smsConsent: true,
      intake: { unit: 'Roof' },
    });
    const [noText] = await rows<{ sms_ok: boolean; consent: string }>(
      admin(),
      sql`select a.sms_ok, p.sms_consent::text as consent from app.appointment_attendees a
          join app.people p on p.id = a.person_id where a.id = ${third.attendeeId}`,
    );
    expect(noText).toEqual({ sms_ok: false, consent: 'unknown' });

    // A retried submit books once; a paused calendar takes no bookings.
    const clientId = randomUUID();
    const retry = { clientId, intake: { unit: 'Shed' } };
    const once = await bookOnline(t, online.id, isoAt(day, '15:00'), retry);
    const twice = await bookOnline(t, online.id, isoAt(day, '15:00'), retry);
    expect(twice).toMatchObject({ appointmentId: once.appointmentId, duplicate: true });
    await run(
      calendarSetStatus,
      { workspaceId: t.wsId, calendarId: online.id, status: 'paused' },
      t.owner,
    );
    await expectHfos(
      () => bookOnline(t, online.id, isoAt(day, '16:00'), { intake: { unit: 'Barn' } }),
      'calendar_not_bookable',
      409,
    );
  });

  it('lets customers reschedule and cancel within the policy, with current links only', async () => {
    const day = nextWeekday(5);
    const cal = await makeCalendar(t, 'Policy', {
      public: true,
      team: { members: [{ userId: t.marco.id }] },
      policies: { cancel: { cutoffHours: 24 }, reschedule: { cutoffHours: 24, maxTimes: 1 } },
    });
    const booked = await bookOnline(t, cal.id, isoAt(day, '09:00'));
    await expectHfos(
      () =>
        runSystem(
          attendeeCancelOnline,
          {
            workspaceId: t.wsId,
            attendeeId: booked.attendeeId,
            manageVersion: booked.manageVersion + 1,
          },
          t.scope,
        ),
      'manage_link_stale',
      410,
    );
    const moved = await runSystem(
      attendeeRescheduleOnline,
      {
        workspaceId: t.wsId,
        attendeeId: booked.attendeeId,
        manageVersion: booked.manageVersion,
        startsAt: isoAt(day, '14:00'),
      },
      t.scope,
    );
    expect(moved).toMatchObject({
      appointmentId: booked.appointmentId,
      attendeeId: booked.attendeeId,
      startsAt: isoAt(day, '14:00'),
    });
    await expectHfos(
      () =>
        runSystem(
          attendeeRescheduleOnline,
          {
            workspaceId: t.wsId,
            attendeeId: booked.attendeeId,
            manageVersion: booked.manageVersion,
            startsAt: isoAt(day, '15:00'),
          },
          t.scope,
        ),
      'reschedule_limit',
      409,
    );
    const cancelled = await runSystem(
      attendeeCancelOnline,
      { workspaceId: t.wsId, attendeeId: booked.attendeeId, manageVersion: booked.manageVersion },
      t.scope,
    );
    expect(cancelled.appointmentCancelled).toBe(true);

    const strict = await makeCalendar(t, 'Strict', {
      public: true,
      team: { members: [{ userId: t.marco.id }] },
      policies: { cancel: { cutoffHours: 720 } },
    });
    const late = await bookOnline(t, strict.id, isoAt(day, '10:00'));
    await expectHfos(
      () =>
        runSystem(
          attendeeCancelOnline,
          { workspaceId: t.wsId, attendeeId: late.attendeeId, manageVersion: late.manageVersion },
          t.scope,
        ),
      'cancel_cutoff',
      409,
    );
  });
});

describe('series, sessions and waitlists', () => {
  it('repeats weekly, skipping a date that doesn’t fit, and cancels this and the following ones', async () => {
    const cal = await makeCalendar(t, 'Maintenance plan', {
      team: { members: [{ userId: t.priya.id }] },
    });
    const first = nextWeekday(1, 7);
    await run(
      appointmentCreate,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        startsAt: isoAt(addDays(first, 7), '10:00'),
        userIds: [t.priya.id],
      },
      t.owner,
    );
    const person = await customer(t, 'Sal');
    const made = await run(
      seriesCreate,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        firstDate: first,
        rule: { freq: 'weekly', count: 4, localTime: '10:00' },
        personId: person,
      },
      t.owner,
    );
    expect(made.appointmentIds).toHaveLength(3);
    expect(made.skipped).toEqual([
      expect.objectContaining({
        occurrence: 2,
        date: addDays(first, 7),
        reason: 'Priya Tech already has an appointment then.',
      }),
    ]);
    const cancelled = await run(
      seriesCancel,
      { workspaceId: t.wsId, appointmentId: made.appointmentIds[1]!, scope: 'following' },
      t.owner,
    );
    expect(cancelled.cancelled).toEqual(made.appointmentIds.slice(1));
    const left = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.appointments where series_id = ${made.seriesId} order by occurrence`,
    );
    expect(left.map((r) => r.status)).toEqual(['scheduled', 'cancelled', 'cancelled']);
  });

  it('books a series from a lead’s page with every visit on the lead, and asks for the first confirmation', async () => {
    // New appointment's Repeats: booked from a lead, and with Tell ticked.
    const cal = await makeCalendar(t, 'Filter changes', {
      team: { members: [{ userId: t.priya.id }] },
    });
    const person = await customer(t, 'Rene');
    const { leadId } = await run(
      leadCreate,
      { workspaceId: t.wsId, title: 'Filter plan', personId: person },
      t.owner,
    );
    const made = await run(
      seriesCreate,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        firstDate: nextWeekday(2, 7),
        rule: { freq: 'weekly', interval: 2, count: 3, localTime: '09:00' },
        personId: person,
        leadId,
        notify: true,
      },
      t.owner,
    );
    expect(made.appointmentIds).toHaveLength(3);
    const leads = await rows<{ lead_id: string | null }>(
      admin(),
      sql`select lead_id from app.appointments where series_id = ${made.seriesId}`,
    );
    expect(leads.map((r) => r.lead_id)).toEqual([leadId, leadId, leadId]);
    const [event] = await rows<{ payload: { notify?: boolean } }>(
      admin(),
      sql`select payload from app.events where event_type = 'series.created' and entity_id = ${made.seriesId}`,
    );
    expect(event!.payload.notify).toBe(true);
  });

  it('keeps a waitlist on a full session and signals when a seat opens', async () => {
    const cal = await makeCalendar(t, 'Class of one', {
      public: true,
      team: { members: [{ userId: t.owner.id }] },
      schedule: { mode: 'sessions' },
      waitlist: { enabled: true },
    });
    const day = nextWeekday(2, 10);
    const session = await run(
      sessionPublish,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        startsAt: isoAt(day, '10:00'),
        userIds: [t.owner.id],
      },
      t.owner,
    );
    const ann = await customer(t, 'Ann');
    const ben = await customer(t, 'Ben');
    const added = await run(
      appointmentAddAttendee,
      { workspaceId: t.wsId, appointmentId: session.appointmentId, personId: ann },
      t.owner,
    );
    expect(added).toMatchObject({ seatsTaken: 1, capacity: 1 });
    await expectHfos(
      () =>
        run(
          appointmentAddAttendee,
          { workspaceId: t.wsId, appointmentId: session.appointmentId, personId: ben },
          t.owner,
        ),
      'session_full',
      409,
    );
    const entry = await run(
      waitlistAdd,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        appointmentId: session.appointmentId,
        personId: ben,
      },
      t.owner,
    );
    expect(entry.position).toBe(1);
    const left = await run(
      appointmentRemoveAttendee,
      { workspaceId: t.wsId, appointmentId: session.appointmentId, personId: ann },
      t.owner,
    );
    expect(left.seatsTaken).toBe(0);
    const [freed] = await rows<{ payload: { waiting: number } }>(
      admin(),
      sql`select payload from app.events where event_type = 'waitlist.seat_freed' and entity_id = ${session.appointmentId}`,
    );
    expect(freed!.payload.waiting).toBe(1);
    await run(waitlistRemove, { workspaceId: t.wsId, entryId: entry.entryId }, t.owner);
    const [status] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.waitlist_entries where id = ${entry.entryId}`,
    );
    expect(status!.status).toBe('removed');
    expect(localDateOf(Date.parse(isoAt(day, '10:00')), CHI)).toBe(day);
  });
});
