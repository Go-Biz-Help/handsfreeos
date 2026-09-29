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
  serviceCreate,
  serviceUpdate,
  seriesCreate,
  sessionPublish,
  timeOffAdd,
  timelineList,
  waitlistAdd,
  waitlistExpire,
  waitlistList,
  waitlistPromote,
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
  MIN,
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

  it('says why nobody can take a booking the calendar chooses for, and where to fix it', async () => {
    const day = nextWeekday(4);
    const bookOn = (calendarId: string, input: Record<string, unknown> = {}) =>
      run(
        appointmentCreate,
        { workspaceId: t.wsId, calendarId, startsAt: isoAt(day, '10:00'), ...input },
        t.owner,
      );
    const empty = await makeCalendar(t, 'Nobody yet', {
      team: { members: [], assignment: 'round_robin' },
    });
    const noTeam = await expectHfos(() => bookOn(empty.id), 'no_one_eligible', 409);
    expect(noTeam.message).toContain('nobody on its team');
    expect(noTeam.message).toContain('Team & assignment');

    // Saving the calendar refuses this, so it comes about when the service changes afterwards.
    const service = await run(
      serviceCreate,
      { workspaceId: t.wsId, name: 'Duct cleaning', durations: [60] },
      t.owner,
    );
    const priyaOnly = await makeCalendar(t, 'Priya only', {
      team: { members: [{ userId: t.priya.id }], assignment: 'round_robin' },
      services: { mode: 'choice', items: [{ serviceId: service.serviceId, overrides: {} }] },
    });
    await run(
      serviceUpdate,
      { workspaceId: t.wsId, serviceId: service.serviceId, staffUserIds: [t.marco.id] },
      t.owner,
    );
    const wrongPeople = await expectHfos(
      () => bookOn(priyaOnly.id, { serviceId: service.serviceId }),
      'no_one_eligible',
      409,
    );
    expect(wrongPeople.message).toContain('Nobody on this calendar’s team does Duct cleaning');
    expect(wrongPeople.message).toContain('Who can do it');
    // Choosing the person yourself still books it.
    const byHand = await bookOn(priyaOnly.id, {
      serviceId: service.serviceId,
      userIds: [t.priya.id],
      acknowledgeWarnings: true,
    });
    expect(byHand.userIds).toEqual([t.priya.id]);

    const crew = await makeCalendar(t, 'Crew of two', {
      team: {
        members: [{ userId: t.priya.id }, { userId: t.marco.id }],
        assignment: 'round_robin',
        crewSize: 2,
      },
    });
    // Priya took the 10:00 above; now Marco is busy too.
    await bookOn(visits.id, { userIds: [t.marco.id], acknowledgeWarnings: true });
    const short = await expectHfos(() => bookOn(crew.id), 'not_enough_people', 409);
    expect(short.message).toBe(
      'This booking needs 2 people and nobody is free then. Pick another time, or lower People per booking under Team & assignment in the calendar’s settings.',
    );
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
    expect(
      (await ask(waitlistList, { workspaceId: t.wsId, calendarId: cal.id }, t.owner)).items,
    ).toEqual([
      expect.objectContaining({
        id: entry.entryId,
        personId: ben,
        fullName: 'Ben Customer',
        status: 'waiting',
        appointment: expect.objectContaining({
          id: session.appointmentId,
          startsAt: isoAt(day, '10:00'),
        }),
        wantedFrom: null,
      }),
    ]);
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

  it('lists who waits for a window of time, which no appointment shows, and takes them off', async () => {
    const cal = await makeCalendar(t, 'Tune-up line', {
      team: { members: [{ userId: t.owner.id }] },
      waitlist: { enabled: true },
    });
    const day = nextWeekday(3, 10);
    const [dee, eli] = [await customer(t, 'Dee'), await customer(t, 'Eli')];
    const want = (personId: string, from: string, to: string) =>
      run(
        waitlistAdd,
        {
          workspaceId: t.wsId,
          calendarId: cal.id,
          personId,
          wantedFrom: isoAt(day, from),
          wantedTo: isoAt(day, to),
        },
        t.owner,
      );
    const first = await want(dee, '09:00', '12:00');
    const second = await want(eli, '13:00', '15:00');
    const list = () => ask(waitlistList, { workspaceId: t.wsId, calendarId: cal.id }, t.owner);
    expect(await list()).toEqual({
      timezone: CHI,
      items: [
        expect.objectContaining({
          id: first.entryId,
          personId: dee,
          fullName: 'Dee Customer',
          status: 'waiting',
          position: 1,
          appointment: null,
          wantedFrom: isoAt(day, '09:00'),
          wantedTo: isoAt(day, '12:00'),
          offerExpiresAt: null,
        }),
        expect.objectContaining({ id: second.entryId, position: 2 }),
      ],
    });
    // A teammate who only reads sees them too.
    expect(
      (await ask(waitlistList, { workspaceId: t.wsId, calendarId: cal.id }, t.member)).items,
    ).toHaveLength(2);

    await run(waitlistRemove, { workspaceId: t.wsId, entryId: first.entryId }, t.owner);
    expect((await list()).items.map((e) => e.id)).toEqual([second.entryId]);
    const [removed] = await rows<{ entity_type: string; entity_id: string }>(
      admin(),
      sql`select entity_type, entity_id from app.events
          where event_type = 'waitlist.removed' and payload ->> 'entryId' = ${first.entryId}`,
    );
    expect(removed).toEqual({ entity_type: 'calendar', entity_id: cal.id });
  });

  it('won’t take someone off who is already booked from the waitlist, and leaves them booked', async () => {
    const cal = await makeCalendar(t, 'Class of one, again', {
      public: true,
      team: { members: [{ userId: t.owner.id }] },
      schedule: { mode: 'sessions' },
      waitlist: { enabled: true },
    });
    const day = nextWeekday(4, 10);
    const { appointmentId } = await run(
      sessionPublish,
      {
        workspaceId: t.wsId,
        calendarId: cal.id,
        startsAt: isoAt(day, '10:00'),
        userIds: [t.owner.id],
      },
      t.owner,
    );
    const [cat, dan] = [await customer(t, 'Cat'), await customer(t, 'Dan')];
    await run(
      appointmentAddAttendee,
      { workspaceId: t.wsId, appointmentId, personId: cat },
      t.owner,
    );
    const entry = await run(
      waitlistAdd,
      { workspaceId: t.wsId, calendarId: cal.id, appointmentId, personId: dan },
      t.owner,
    );
    await run(
      appointmentRemoveAttendee,
      { workspaceId: t.wsId, appointmentId, personId: cat },
      t.owner,
    );
    // The worker hands Dan the freed seat, as a customer taking their offer books theirs.
    const promoted = await runSystem(
      waitlistPromote,
      { workspaceId: t.wsId, appointmentId },
      t.scope,
    );
    expect(promoted.booked).toEqual([
      expect.objectContaining({ entryId: entry.entryId, personId: dan }),
    ]);
    // A Remove pressed on a list that still showed Dan waiting.
    await expectHfos(
      () => run(waitlistRemove, { workspaceId: t.wsId, entryId: entry.entryId }, t.owner),
      'already_booked',
      409,
    );
    const [after] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.waitlist_entries where id = ${entry.entryId}`,
    );
    expect(after!.status).toBe('booked');
    const [seat] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.appointment_attendees
          where appointment_id = ${appointmentId} and person_id = ${dan}`,
    );
    expect(seat!.status).toBe('booked');
  });

  it('ends a wait for a window of time once all of it has passed, and the list leaves it out', async () => {
    const cal = await makeCalendar(t, 'Morning line', {
      team: { members: [{ userId: t.owner.id }] },
      waitlist: { enabled: true },
    });
    const day = nextWeekday(5, 10);
    const [fay, gus] = [await customer(t, 'Fay'), await customer(t, 'Gus')];
    const want = (personId: string) =>
      run(
        waitlistAdd,
        {
          workspaceId: t.wsId,
          calendarId: cal.id,
          personId,
          wantedFrom: isoAt(day, '09:00'),
          wantedTo: isoAt(day, '12:00'),
        },
        t.owner,
      );
    const passed = await want(fay);
    const still = await want(gus);
    const list = async () =>
      (await ask(waitlistList, { workspaceId: t.wsId, calendarId: cal.id }, t.owner)).items.map(
        (e) => e.id,
      );
    const expire = () =>
      runSystem(waitlistExpire, { workspaceId: t.wsId, entryId: passed.entryId }, t.scope);
    // Still to come: nothing ends yet, and the worker hears when it will.
    expect(await expire()).toEqual({
      status: 'waiting',
      expired: false,
      expiresAt: isoAt(day, '12:00'),
      fromAppointmentId: null,
    });

    // Fay's morning comes and goes with no opening.
    await rows(
      admin(),
      sql`update app.waitlist_entries set wanted_from = now() - interval '4 hours',
            wanted_to = now() - interval '1 minute'
          where id = ${passed.entryId}`,
    );
    // Off the list at once, before the worker gets to it.
    expect(await list()).toEqual([still.entryId]);
    expect(await expire()).toEqual({
      status: 'expired',
      expired: true,
      expiresAt: null,
      fromAppointmentId: null,
    });
    const statuses = await rows<{ id: string; status: string }>(
      admin(),
      sql`select id, status::text as status from app.waitlist_entries where calendar_id = ${cal.id}`,
    );
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [passed.entryId]: 'expired',
      [still.entryId]: 'waiting',
    });
    const [ended] = await rows<{ entity_type: string; action: string; after: unknown }>(
      admin(),
      sql`select e.entity_type, l.action, l.after from app.events e
          join app.audit_logs l on l.event_id = e.id
          where e.event_type = 'waitlist.window_passed' and e.payload ->> 'entryId' = ${passed.entryId}`,
    );
    expect(ended).toMatchObject({
      entity_type: 'calendar',
      action: 'waitlist.expire',
      after: { customer: 'Fay Customer', status: 'expired', reason: 'window_passed' },
    });
    // Done once: running it again changes nothing.
    expect(await expire()).toMatchObject({ status: 'expired', expired: false });
    expect(await list()).toEqual([still.entryId]);
  });

  it('won’t put someone on the waitlist for times that have passed, as the booking page won’t', async () => {
    const cal = await makeCalendar(t, 'Late line', {
      team: { members: [{ userId: t.owner.id }] },
      waitlist: { enabled: true },
    });
    const gil = await customer(t, 'Gil');
    const want = (wantedFrom: string, wantedTo: string) =>
      run(
        waitlistAdd,
        { workspaceId: t.wsId, calendarId: cal.id, personId: gil, wantedFrom, wantedTo },
        t.owner,
      );
    const hoursFromNow = (h: number) => new Date(Date.now() + h * 60 * MIN).toISOString();
    // This morning, already over: it would only expire at once.
    const gone = await expectHfos(
      () => want(hoursFromNow(-5), hoursFromNow(-1)),
      'validation',
      400,
    );
    expect(gone.message).toBe('Pick times that haven’t passed.');
    expect(gone.details).toEqual([
      { path: 'wantedTo', message: 'Pick times that haven’t passed.' },
    ]);
    const day = nextWeekday(2, 10);
    const backwards = await expectHfos(
      () => want(isoAt(day, '12:00'), isoAt(day, '09:00')),
      'validation',
      400,
    );
    expect(backwards.message).toBe('End after the start.');
    // Under way with some of it still to come: that's a wait worth keeping.
    const now = await want(hoursFromNow(-1), hoursFromNow(2));
    expect(
      (await ask(waitlistList, { workspaceId: t.wsId, calendarId: cal.id }, t.owner)).items.map(
        (e) => e.id,
      ),
    ).toEqual([now.entryId]);

    // Nor a session that has already started.
    const classes = await makeCalendar(t, 'Started class', {
      public: true,
      team: { members: [{ userId: t.owner.id }] },
      schedule: { mode: 'sessions' },
      waitlist: { enabled: true },
    });
    const { appointmentId } = await run(
      sessionPublish,
      {
        workspaceId: t.wsId,
        calendarId: classes.id,
        startsAt: isoAt(nextWeekday(5, 10), '15:00'),
        userIds: [t.owner.id],
      },
      t.owner,
    );
    // It ran earlier today (still marked scheduled: nobody has said how it went).
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '3 hours',
            ends_at = now() - interval '2 hours'
          where id = ${appointmentId}`,
    );
    await expectHfos(
      () =>
        run(
          waitlistAdd,
          { workspaceId: t.wsId, calendarId: classes.id, appointmentId, personId: gil },
          t.owner,
        ),
      'session_started',
      409,
    );
  });

  it('ends a wait for a session once it is cancelled or starts, and the lists leave it out', async () => {
    const cal = await makeCalendar(t, 'Evening class', {
      public: true,
      team: { members: [{ userId: t.owner.id }] },
      schedule: { mode: 'sessions' },
      waitlist: { enabled: true },
    });
    const publish = async (day: string) =>
      (
        await run(
          sessionPublish,
          {
            workspaceId: t.wsId,
            calendarId: cal.id,
            startsAt: isoAt(day, '14:00'),
            userIds: [t.owner.id],
          },
          t.owner,
        )
      ).appointmentId;
    const [monday, wednesday] = [nextWeekday(1, 10), nextWeekday(3, 10)];
    const [called, started] = [await publish(monday), await publish(wednesday)];
    const [hal, ivy] = [await customer(t, 'Hal'), await customer(t, 'Ivy')];
    const wait = (appointmentId: string, personId: string) =>
      run(
        waitlistAdd,
        { workspaceId: t.wsId, calendarId: cal.id, appointmentId, personId },
        t.owner,
      );
    const halWaits = await wait(called, hal);
    const ivyWaits = await wait(started, ivy);
    const list = async () =>
      (await ask(waitlistList, { workspaceId: t.wsId, calendarId: cal.id }, t.owner)).items.map(
        (e) => e.id,
      );
    const onSheet = async (appointmentId: string) =>
      (
        await ask(appointmentGet, { workspaceId: t.wsId, appointmentId }, t.owner)
      ).appointment.waitlist.map((w) => w.id);
    const expire = (entryId: string) =>
      runSystem(waitlistExpire, { workspaceId: t.wsId, entryId }, t.scope);
    const ended = async (entryId: string) =>
      (
        await rows<{ entity_type: string; entity_id: string; action: string; after: unknown }>(
          admin(),
          sql`select e.entity_type, e.entity_id, l.action, l.after from app.events e
              join app.audit_logs l on l.event_id = e.id
              where e.event_type = 'waitlist.session_passed' and e.payload ->> 'entryId' = ${entryId}`,
        )
      )[0];
    // Still ahead: nothing ends yet, and the worker hears it ends when the session starts.
    expect(await expire(halWaits.entryId)).toEqual({
      status: 'waiting',
      expired: false,
      expiresAt: isoAt(monday, '14:00'),
      fromAppointmentId: null,
    });
    expect(await list()).toEqual([halWaits.entryId, ivyWaits.entryId]);
    expect(await onSheet(called)).toEqual([halWaits.entryId]);

    // Monday's class is called off: Hal is off the lists at once, before the worker gets to him.
    await run(
      appointmentCancel,
      { workspaceId: t.wsId, appointmentId: called, notify: false },
      t.owner,
    );
    expect(await list()).toEqual([ivyWaits.entryId]);
    expect(await onSheet(called)).toEqual([]);
    expect(await expire(halWaits.entryId)).toEqual({
      status: 'expired',
      expired: true,
      expiresAt: null,
      fromAppointmentId: null,
    });
    expect(await ended(halWaits.entryId)).toMatchObject({
      entity_type: 'appointment',
      entity_id: called,
      action: 'waitlist.expire',
      after: { customer: 'Hal Customer', status: 'expired', reason: 'session_cancelled' },
    });

    // Wednesday's class starts with nobody freeing a seat.
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '10 minutes',
            ends_at = now() + interval '50 minutes'
          where id = ${started}`,
    );
    expect(await list()).toEqual([]);
    expect(await onSheet(started)).toEqual([]);
    expect(await expire(ivyWaits.entryId)).toMatchObject({ status: 'expired', expired: true });
    expect(await ended(ivyWaits.entryId)).toMatchObject({
      after: { customer: 'Ivy Customer', status: 'expired', reason: 'session_started' },
    });
    const statuses = await rows<{ id: string; status: string }>(
      admin(),
      sql`select id, status::text as status from app.waitlist_entries where calendar_id = ${cal.id}`,
    );
    expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
      [halWaits.entryId]: 'expired',
      [ivyWaits.entryId]: 'expired',
    });
    // Done once: running it again changes nothing.
    expect(await expire(ivyWaits.entryId)).toMatchObject({ status: 'expired', expired: false });
  });
});
