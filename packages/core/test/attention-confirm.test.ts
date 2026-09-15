/**
 * M8 step 3 on the local database: confirming a booking. A reply of C (CONFIRM, CONFIRMED) confirms the sender's
 * outstanding asks and waits for no reply; YES also confirms while an ask is open and still opts them in; YES
 * with nothing asked only opts in; CANCEL is still STOP. Staff mark a booking confirmed (and take back only their
 * own mark), the manage link's Confirm button confirms once, a sent reminder records the ask, a moved booking
 * needs confirming again, and the Action Center's item clears when the customer confirms.
 */
import { randomUUID } from 'node:crypto';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcile } from '../src/attention/load';
import { addDays, localDateOf, weekdayOf } from '../src/calendar/index';
import {
  appointmentGet,
  appointmentList,
  appointmentReschedule,
  attendeeConfirm,
  attendeeConfirmOnline,
  attendeeRecordReminder,
  attentionSaveSettings,
  messageReceive,
  personCreate,
} from '../src/server';
import {
  admin,
  ask,
  bookOnline,
  CHI,
  expectHfos,
  isoAt,
  makeCalendar,
  nextPhone,
  run,
  runSystem,
  setupTeam,
  type Team,
} from './calendar-helpers';

let t: Team;
let calendarId: string;
/** The first weekday after today (Chicago), so bookings are soon. */
let day: string;

beforeAll(async () => {
  t = await setupTeam('confirm');
  calendarId = (
    await makeCalendar(t, 'Visits', { public: true, team: { members: [{ userId: t.priya.id }] } })
  ).id;
  day = addDays(localDateOf(Date.now(), CHI), 1);
  while (weekdayOf(day) === 0 || weekdayOf(day) === 6) day = addDays(day, 1);
  // Unconfirmed bookings open within a week here, so the tests don't depend on the weekday.
  await run(
    attentionSaveSettings,
    { workspaceId: t.wsId, settings: { appointments: { windowHours: 168 } } },
    t.owner,
  );
});
afterAll(closeTestDbs);

async function booked(clock: string, phone = nextPhone()) {
  const out = await bookOnline(t, calendarId, isoAt(day, clock), {
    customer: { firstName: 'Rosa', lastName: `Diaz ${clock}`, phone },
    smsConsent: true,
  });
  return { ...out, phone };
}
/** The day-before text went out, asking them to reply C. */
const asked = (seat: { attendeeId: string; startsAt: string }) =>
  runSystem(
    attendeeRecordReminder,
    {
      workspaceId: t.wsId,
      attendeeId: seat.attendeeId,
      key: 'day_before',
      status: 'sent',
      channel: 'sms',
      startsAt: seat.startsAt,
      askedToConfirm: true,
    },
    t.scope,
  );
const text = (from: string, body: string) =>
  runSystem(
    messageReceive,
    {
      workspaceId: t.wsId,
      provider: 'fake',
      providerMessageId: `SMcf-${randomUUID()}`,
      from,
      to: '+18005550100',
      body,
    },
    t.scope,
  );
const seatOf = async (id: string) =>
  (
    await rows<{
      confirmed_at: Date | null;
      confirmed_via: string | null;
      confirmed_by: string | null;
      confirm_asked_at: Date | null;
    }>(
      admin(),
      sql`select confirmed_at, confirmed_via, confirmed_by, confirm_asked_at from app.appointment_attendees where id = ${id}`,
    )
  )[0]!;
const conversationOf = async (id: string) =>
  (
    await rows<{ awaiting_reply_since: Date | null; unread_count: number }>(
      admin(),
      sql`select awaiting_reply_since, unread_count from app.conversations where id = ${id}`,
    )
  )[0]!;
const consentOf = async (phone: string) =>
  (
    await rows<{ sms_consent: string }>(
      admin(),
      sql`select sms_consent::text as sms_consent from app.people where workspace_id = ${t.wsId} and phone_e164 = ${phone}`,
    )
  )[0]?.sms_consent;
const settleSeat = (attendeeId: string) =>
  asWorker(testDbs().worker.db, t.scope, (tx) =>
    reconcile(tx, t.wsId, [{ type: 'attendee', id: attendeeId }]),
  );

describe('asking and confirming by text', () => {
  it('a sent reminder opens the ask, and a replay leaves it', async () => {
    const seat = await booked('08:00');
    expect((await seatOf(seat.attendeeId)).confirm_asked_at).toBeNull();
    expect(await asked(seat)).toMatchObject({ changed: true });
    const first = (await seatOf(seat.attendeeId)).confirm_asked_at;
    expect(first).not.toBeNull();
    expect(await asked(seat)).toMatchObject({ changed: false });
    expect((await seatOf(seat.attendeeId)).confirm_asked_at).toEqual(first);
  });

  it('C confirms the sender’s outstanding ask, waits for no reply, and clears the item', async () => {
    const seat = await booked('09:00');
    const opened = await settleSeat(seat.attendeeId);
    expect(opened.transitions).toMatchObject([{ type: 'opened', kind: 'unconfirmed_appointment' }]);
    await asked(seat);

    const got = await text(seat.phone, 'c');
    expect(got).toMatchObject({ keyword: 'confirm', confirmedAttendeeIds: [seat.attendeeId] });
    expect(await seatOf(seat.attendeeId)).toMatchObject({
      confirmed_via: 'sms',
      confirmed_by: null,
    });
    const conv = await conversationOf(got.conversationId);
    expect(conv.awaiting_reply_since).toBeNull();
    const jobs = await rows(
      admin(),
      sql`select 1 from app.scheduled_jobs where dedupe_key = ${`unanswered:${got.conversationId}`} and status = 'pending'`,
    );
    expect(jobs).toHaveLength(0);
    const [event] = await rows<{ payload: Record<string, unknown> }>(
      admin(),
      sql`select payload from app.events where event_type = 'attendee.confirmed' and payload ->> 'attendeeId' = ${seat.attendeeId}`,
    );
    expect(event!.payload).toMatchObject({
      via: 'sms',
      by: 'customer',
      conversationId: got.conversationId,
    });

    expect((await settleSeat(seat.attendeeId)).transitions).toMatchObject([
      { type: 'resolved', kind: 'unconfirmed_appointment', resolution: 'confirmed' },
    ]);
    // A second C changes nothing and still waits for no reply.
    const again = await text(seat.phone, 'CONFIRMED!');
    expect(again).toMatchObject({ keyword: 'confirm', confirmedAttendeeIds: [] });
    expect((await conversationOf(again.conversationId)).awaiting_reply_since).toBeNull();
  });

  it('YES confirms while an ask is open, and still opts them in', async () => {
    const seat = await booked('10:00');
    await asked(seat);
    expect(await text(seat.phone, 'STOP')).toMatchObject({
      keyword: 'stop',
      confirmedAttendeeIds: [],
    });
    expect(await consentOf(seat.phone)).toBe('opted_out');
    expect((await seatOf(seat.attendeeId)).confirmed_at).toBeNull();
    const yes = await text(seat.phone, 'Yes');
    expect(yes).toMatchObject({ keyword: 'start', confirmedAttendeeIds: [seat.attendeeId] });
    expect(await consentOf(seat.phone)).toBe('opted_in');
    expect(await seatOf(seat.attendeeId)).toMatchObject({ confirmed_via: 'sms' });
    expect((await conversationOf(yes.conversationId)).awaiting_reply_since).toBeNull();
  });

  it('YES with nothing asked only opts them in, and a C with nothing asked is an ordinary text', async () => {
    const phone = nextPhone();
    await run(
      personCreate,
      {
        workspaceId: t.wsId,
        firstName: 'Omar',
        lastName: 'Asked Nothing',
        phone,
        ignoreDuplicates: true,
      },
      t.owner,
    );
    await text(phone, 'STOP');
    const yes = await text(phone, 'YES');
    expect(yes).toMatchObject({ keyword: 'start', confirmedAttendeeIds: [] });
    expect(await consentOf(phone)).toBe('opted_in');
    expect((await conversationOf(yes.conversationId)).awaiting_reply_since).not.toBeNull();

    const other = nextPhone();
    const c = await text(other, 'C');
    expect(c).toMatchObject({ keyword: null, confirmedAttendeeIds: [] });
    expect((await conversationOf(c.conversationId)).awaiting_reply_since).not.toBeNull();
  });

  it('CANCEL is still STOP: it opts them out and confirms nothing', async () => {
    const seat = await booked('11:00');
    await asked(seat);
    expect(await text(seat.phone, 'Cancel')).toMatchObject({
      keyword: 'stop',
      confirmedAttendeeIds: [],
    });
    expect(await consentOf(seat.phone)).toBe('opted_out');
    expect((await seatOf(seat.attendeeId)).confirmed_at).toBeNull();
  });
});

describe('confirming for the customer, and on the manage link', () => {
  it('staff mark it confirmed in their own name, and Undo takes back only a staff mark', async () => {
    const seat = await booked('13:00');
    const marked = await run(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: seat.attendeeId },
      t.member,
    );
    expect(marked).toMatchObject({ confirmedVia: 'staff', changed: true });
    expect(await seatOf(seat.attendeeId)).toMatchObject({
      confirmed_via: 'staff',
      confirmed_by: t.member.id,
    });
    expect(
      await run(attendeeConfirm, { workspaceId: t.wsId, attendeeId: seat.attendeeId }, t.owner),
    ).toMatchObject({
      changed: false,
    });
    const undone = await run(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: seat.attendeeId, confirmed: false },
      t.member,
    );
    expect(undone).toMatchObject({ confirmedAt: null, confirmedVia: null, changed: true });

    // The customer confirms themselves: that stays.
    await asked(seat);
    await text(seat.phone, 'C');
    await expectHfos(
      () =>
        run(
          attendeeConfirm,
          { workspaceId: t.wsId, attendeeId: seat.attendeeId, confirmed: false },
          t.owner,
        ),
      'confirmation_not_staff',
      409,
    );
  });

  it('the Confirm button confirms once, and an old link is refused', async () => {
    const seat = await booked('14:00');
    const input = {
      workspaceId: t.wsId,
      attendeeId: seat.attendeeId,
      manageVersion: seat.manageVersion,
    };
    expect(await runSystem(attendeeConfirmOnline, input, t.scope)).toMatchObject({
      confirmedVia: 'link',
      changed: true,
    });
    expect(await runSystem(attendeeConfirmOnline, input, t.scope)).toMatchObject({
      changed: false,
    });
    await expectHfos(
      () =>
        runSystem(
          attendeeConfirmOnline,
          { ...input, manageVersion: seat.manageVersion + 1 },
          t.scope,
        ),
      'manage_link_stale',
      410,
    );
  });

  it('a moved booking needs confirming again', async () => {
    const seat = await booked('15:00');
    await asked(seat);
    await run(attendeeConfirm, { workspaceId: t.wsId, attendeeId: seat.attendeeId }, t.owner);
    await run(
      appointmentReschedule,
      {
        workspaceId: t.wsId,
        appointmentId: seat.appointmentId,
        startsAt: isoAt(day, '16:00'),
        acknowledgeWarnings: true,
        notify: false,
      },
      t.owner,
    );
    expect(await seatOf(seat.attendeeId)).toMatchObject({
      confirmed_at: null,
      confirmed_via: null,
      confirmed_by: null,
      confirm_asked_at: null,
    });
  });
});

describe('the calendar sheet reads it', () => {
  it('appointment.get gives each booking’s confirmation: when, how, who marked it, and when it was asked', async () => {
    const seat = await booked('12:00');
    const attendee = async () =>
      (
        await ask(
          appointmentGet,
          { workspaceId: t.wsId, appointmentId: seat.appointmentId },
          t.owner,
        )
      ).appointment.attendees.find((a) => a.id === seat.attendeeId)!;
    expect(await attendee()).toMatchObject({
      confirmedAt: null,
      confirmedVia: null,
      confirmedBy: null,
      confirmAskedAt: null,
    });

    await asked(seat);
    const askedAt = new Date((await seatOf(seat.attendeeId)).confirm_asked_at!).toISOString();
    expect((await attendee()).confirmAskedAt).toBe(askedAt);

    await run(attendeeConfirm, { workspaceId: t.wsId, attendeeId: seat.attendeeId }, t.member);
    const marked = await attendee();
    expect(marked).toMatchObject({
      confirmedVia: 'staff',
      confirmedBy: { id: t.member.id, fullName: 'Mike Member' },
      confirmAskedAt: askedAt,
    });
    expect(marked.confirmedAt).toBe(
      new Date((await seatOf(seat.attendeeId)).confirmed_at!).toISOString(),
    );
    // appointment.list gives the same fields under the same names (Home's Today card reads it).
    const { items } = await ask(
      appointmentList,
      {
        workspaceId: t.wsId,
        from: new Date(Date.parse(seat.startsAt) - 60_000).toISOString(),
        to: new Date(Date.parse(seat.startsAt) + 60_000).toISOString(),
        calendarIds: [calendarId],
      },
      t.owner,
    );
    const listed = items
      .find((i) => i.id === seat.appointmentId)!
      .attendees.find((a) => a.id === seat.attendeeId)!;
    expect(listed).toMatchObject({
      confirmedAt: marked.confirmedAt,
      confirmedVia: 'staff',
      confirmedBy: marked.confirmedBy,
      confirmAskedAt: askedAt,
    });

    // Taken back, then the customer replies C: confirmed by text, with nobody's name on it.
    await run(
      attendeeConfirm,
      { workspaceId: t.wsId, attendeeId: seat.attendeeId, confirmed: false },
      t.member,
    );
    await text(seat.phone, 'C');
    expect(await attendee()).toMatchObject({
      confirmedVia: 'sms',
      confirmedBy: null,
      confirmAskedAt: askedAt,
    });
  });
});
