/**
 * What customers and the team hear about bookings, on the real database with the fake carrier and Mailpit:
 * several handlers per event (a retry runs them all again), online confirmations by text (STOP wording on the
 * first) or by email, the quiet-hours hold, staff bookings and their notify switch, the team's "New booking"
 * email and its setting, change and cancel notices, and conversations left as they were.
 */
import { randomUUID } from 'node:crypto';
import {
  appointmentCreate,
  appointmentReschedule,
  formatPhone,
  localDateOf,
  localInstant,
  addDays,
  messageSend,
  personCreate,
  resourceCreate,
  smsSegments,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayLong, dayShort, weekdayShort } from '../src/booking/when';
import { onAppointmentChanged } from '../src/handlers/calendar';
import { handlers } from '../src/handlers/index';
import type { HandlerMap } from '../src/handlers/types';
import { processOnce } from '../src/outbox';
import { recordSystemEvent } from '../src/system-event';
import {
  admin,
  at,
  AT_HOME,
  attendeeByToken,
  BUSINESS,
  bookOnline,
  CHI,
  customer,
  drain,
  emailsTo,
  hh,
  HOUR,
  hourNow,
  iso,
  mailTo,
  makeCalendar,
  makeWorld,
  nextPhone,
  post,
  readyTexting,
  run,
  runDue,
  setQuietHours,
  stateOf,
  textsTo,
  waitForMail,
  type World,
} from './booking-world';

let w: World;
let cal: { id: string; slug: string };
/** Nora's number, which has had a text from the business. */
let noraPhone: string;

beforeAll(async () => {
  w = await makeWorld('msg');
  await readyTexting(w);
  cal = await makeCalendar(w, 'AC tune-up', {
    locations: { options: [{ kind: 'customer_address' }] },
  });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

describe('several handlers per event', () => {
  it('runs them in order in one pass, and a retry runs every one of them again', async () => {
    const calls: string[] = [];
    let failOnce = true;
    const map: HandlerMap = {
      'test.two_handlers': [
        async () => {
          calls.push('first');
        },
        async () => {
          calls.push('second');
          if (failOnce) {
            failOnce = false;
            throw new Error('not yet');
          }
        },
      ],
    };
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const eventId = await asWorker(testDbs().worker.db, scope, (tx) =>
      recordSystemEvent(tx, {
        type: 'test.two_handlers',
        action: 'test.two_handlers',
        ...scope,
        entityType: 'workspace',
        entityId: w.workspaceId,
        correlationId: randomUUID(),
        causationId: randomUUID(),
      }),
    );
    const reserve = () =>
      rows(
        admin(),
        sql`update app.outbox set locked_at = now(), locked_by = ${w.workerId}, next_attempt_at = now()
            where event_id = ${eventId}`,
      );
    const deps = { ...w.s, handlers: map, workerId: w.workerId, batchSize: 10, reservedOnly: true };
    await reserve();
    expect((await processOnce(deps)).retried).toBe(1);
    expect(calls).toEqual(['first', 'second']);
    await reserve();
    expect((await processOnce(deps)).done).toBe(1);
    expect(calls).toEqual(['first', 'second', 'first', 'second']);
    const [row] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.outbox where event_id = ${eventId}`,
    );
    expect(row!.status).toBe('done');
    // A booked appointment still reaches people's own calendars first, then the reminders and messages.
    const booked = handlers['appointment.booked'];
    expect(Array.isArray(booked) && booked[0]).toBe(onAppointmentChanged);
    expect([handlers['appointment.updated']].flat()[0]).toBe(onAppointmentChanged);
  });
});

describe('confirmations', () => {
  it('confirms an online booking by text when the customer agreed, STOP wording on the first text', async () => {
    const start = at(3, '10:00');
    const c = customer('Nora');
    noraPhone = c.phone;
    const booked = await bookOnline(w, cal.slug, start, { ...c, smsConsent: true, ...AT_HOME });
    await drain(w);
    const texts = textsTo(w, c.phone);
    expect(texts).toHaveLength(1);
    const body = texts[0]!.body;
    expect(body).toBe(
      `${BUSINESS}: You're booked for an AC tune-up on ${dayShort(start, CHI)} at 10:00 AM CT. Change or cancel: http://localhost:3000/m/${booked.manageToken} Reply STOP to opt out.`,
    );
    expect(body).not.toMatch(/[‘’“”–—·]/);
    expect(smsSegments(body)).toMatchObject({ encoding: 'gsm7' });
    expect(smsSegments(body).segments).toBeLessThanOrEqual(2);
    // One confirmation: no email too.
    expect(await emailsTo(w, c.email)).toEqual([]);

    const attendee = await attendeeByToken(booked.manageToken);
    const state = await stateOf(attendee.id);
    expect(state.confirmation).toMatchObject({ status: 'sent', channel: 'sms' });
    expect(state.reminders['day_before']).toMatchObject({
      status: 'scheduled',
      startsAt: iso(start),
      dueAt: iso(at(2, '16:00')),
    });
    expect(state.reminders['before_120']).toMatchObject({
      status: 'scheduled',
      dueAt: iso(start - 2 * HOUR),
    });
    // The conversation this text started waits on nobody.
    const [conv] = await rows<{ status: string; unread_count: number }>(
      admin(),
      sql`select status::text as status, unread_count from app.conversations
          where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    expect(conv).toEqual({ status: 'closed', unread_count: 0 });

    const mail = await waitForMail(
      w.owner.email,
      `New booking: Nora Customer, AC tune-up, ${weekdayShort(start, CHI)} 10:00 AM`,
    );
    expect(mail.text).toContain('Nora Customer booked an AC tune-up with you online.');
    expect(mail.text).toContain(`Phone: ${formatPhone(c.phone)} · texts OK`);
    expect(mail.text).toContain('Where: 123 Main St, Houston, TX 77002');
  });

  it('confirms by email without the texting box; a later text to a texted number has no STOP wording', async () => {
    const start = at(3, '12:00');
    const c = customer('Omar');
    const booked = await bookOnline(w, cal.slug, start, { ...c, smsConsent: false, ...AT_HOME });
    await drain(w);
    expect(textsTo(w, c.phone)).toEqual([]);
    const mail = await waitForMail(
      c.email,
      `You’re booked: AC tune-up on ${dayShort(start, CHI)} at 12:00 PM`,
    );
    expect(mail.text).toContain('You’re booked, Omar');
    expect(mail.text).toContain('What: AC tune-up · 1 hour');
    expect(mail.text).toContain(`When: ${dayLong(start, CHI)}, 12:00–1:00 PM Central Time`);
    expect(mail.text).toContain('Where: 123 Main St, Houston, TX 77002');
    expect(mail.text).toContain('Who: Dale from Lone Star Test');
    expect(mail.text).toContain(`Change or cancel: http://localhost:3000/m/${booked.manageToken}`);
    expect(mail.text).toContain(
      `You can change or cancel up to the start. After that, call us at ${formatPhone(w.number!)}.`,
    );
    expect(mail.text).toContain('Booking by HandsFreeOS');
    const attendee = await attendeeByToken(booked.manageToken);
    expect((await stateOf(attendee.id)).confirmation).toMatchObject({
      status: 'sent',
      channel: 'email',
      reason: 'no_consent',
    });

    // Nora books again: her number has had its STOP wording.
    const again = at(3, '14:00');
    await bookOnline(w, cal.slug, again, {
      name: 'Nora Customer',
      phone: noraPhone,
      smsConsent: true,
      ...AT_HOME,
    });
    await drain(w);
    const second = textsTo(w, noraPhone).at(-1)!.body;
    expect(second).toMatch(
      /^Lone Star Test HVAC: You're booked for an AC tune-up on .* 2:00 PM CT\. /,
    );
    expect(second).not.toContain('STOP');
  });

  it('in quiet hours, emails the confirmation now and holds the text until they end', async () => {
    const h = hourNow();
    await setQuietHours(w, { start: hh(h - 1), end: hh(h + 2) });
    try {
      const start = at(4, '10:00');
      const c = customer('Quinn');
      const booked = await bookOnline(w, cal.slug, start, { ...c, smsConsent: true, ...AT_HOME });
      await drain(w);
      expect(textsTo(w, c.phone)).toEqual([]);
      await waitForMail(c.email, 'You’re booked: AC tune-up');
      const attendee = await attendeeByToken(booked.manageToken);
      expect((await stateOf(attendee.id)).confirmation).toMatchObject({
        status: 'sent',
        channel: 'email',
        reason: 'quiet_hours',
      });
      const [job] = await rows<{ run_at: Date; dedupe_key: string }>(
        admin(),
        sql`select run_at, dedupe_key from app.scheduled_jobs
            where workspace_id = ${w.workspaceId} and kind = 'appointment.notice' and status = 'pending'
              and payload ->> 'attendeeId' = ${attendee.id}`,
      );
      const today = localDateOf(Date.now(), CHI);
      let end = localInstant(today, hh(h + 2), CHI);
      if (end <= Date.now()) end = localInstant(addDays(today, 1), hh(h + 2), CHI);
      expect(new Date(job!.run_at).getTime()).toBe(end);

      // Quiet hours end: the text goes, and it's this number's first.
      await setQuietHours(w, null);
      await runDue(w, [job!.dedupe_key]);
      const texts = textsTo(w, c.phone);
      expect(texts).toHaveLength(1);
      expect(texts[0]!.body).toMatch(
        /^Lone Star Test HVAC: You're booked for an AC tune-up on .* Reply STOP to opt out\.$/,
      );
      expect((await stateOf(attendee.id)).confirmation).toMatchObject({
        status: 'sent',
        channel: 'sms',
      });
    } finally {
      await setQuietHours(w, null);
    }
  });

  it('staff bookings tell the customer unless notify is off, arm reminders either way, and never email the team', async () => {
    const person = async (first: string) => {
      const phone = nextPhone();
      const { personId } = await run(w, personCreate, {
        workspaceId: w.workspaceId,
        firstName: first,
        lastName: 'Staffbook',
        phone,
        email: `${first.toLowerCase()}-${randomUUID().slice(0, 6)}@example.com`,
      });
      return { personId, phone };
    };
    const quiet = await person('Sam');
    const told = await person('Tess');
    const a = await run(w, appointmentCreate, {
      workspaceId: w.workspaceId,
      calendarId: cal.id,
      startsAt: iso(at(5, '09:00')),
      personId: quiet.personId,
      notify: false,
    });
    await run(w, appointmentCreate, {
      workspaceId: w.workspaceId,
      calendarId: cal.id,
      startsAt: iso(at(5, '11:00')),
      personId: told.personId,
    });
    await drain(w);
    expect(textsTo(w, quiet.phone)).toEqual([]);
    expect(textsTo(w, told.phone)).toHaveLength(1);
    expect(textsTo(w, told.phone)[0]!.body).toContain("You're booked for an AC tune-up");
    const [att] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.appointment_attendees where appointment_id = ${a.appointmentId}`,
    );
    const state = await stateOf(att!.id);
    expect(state.confirmation).toBeNull();
    expect(state.reminders['before_120']).toMatchObject({ status: 'scheduled' });
    expect((await mailTo(w.owner.email)).some((m) => m.Subject.includes('Staffbook'))).toBe(false);
  });
});

describe('the team, and change and cancel notices', () => {
  it('emails the team about online bookings and cancellations as each person’s setting allows, once', async () => {
    await rows(
      admin(),
      sql`update app.users set settings = settings || '{"notifications": {"bookingEmail": false}}'::jsonb
          where id = ${w.owner.id}`,
    );
    const muted = customer('Muted');
    await bookOnline(w, cal.slug, at(6, '09:00'), { ...muted, ...AT_HOME });
    await drain(w);
    await waitForMail(muted.email, 'You’re booked: AC tune-up');
    expect(
      (await mailTo(w.owner.email)).some((m) =>
        m.Subject.startsWith('New booking: Muted Customer'),
      ),
    ).toBe(false);

    await rows(
      admin(),
      sql`update app.users set settings = settings - 'notifications' where id = ${w.owner.id}`,
    );
    const loud = customer('Loud');
    const start = at(6, '11:00');
    const booked = await bookOnline(w, cal.slug, start, { ...loud, smsConsent: true, ...AT_HOME });
    await drain(w);
    await waitForMail(w.owner.email, 'New booking: Loud Customer, AC tune-up');
    const cancelled = await post(w, `/public/manage/${booked.manageToken}/cancel`, {
      reason: 'Fixed it myself',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await drain(w);
    const mail = await waitForMail(w.owner.email, 'Cancelled: Loud Customer, AC tune-up');
    expect(mail.text).toContain('Loud Customer cancelled their AC tune-up online.');
    expect(mail.text).toContain('Why: Fixed it myself');
    const texts = textsTo(w, loud.phone);
    expect(texts.at(-1)!.body).toBe(
      `${BUSINESS}: Your AC tune-up on ${dayShort(start, CHI)} at 11:00 AM CT is cancelled. Book again: http://localhost:3000/book/${w.site}/${cal.slug}`,
    );

    // The event again (a retry): nobody hears it twice.
    const [ev] = await rows<{ id: string }>(
      admin(),
      sql`select id from app.events where workspace_id = ${w.workspaceId} and event_type = 'appointment.cancelled'
          order by created_at desc limit 1`,
    );
    await rows(
      admin(),
      sql`update app.outbox set status = 'pending', next_attempt_at = now() where event_id = ${ev!.id}`,
    );
    await drain(w);
    expect(textsTo(w, loud.phone)).toHaveLength(texts.length);
    const cancels = (await mailTo(w.owner.email)).filter((m) =>
      m.Subject.startsWith('Cancelled: Loud Customer'),
    );
    expect(cancels).toHaveLength(1);
  });

  it('tells the customer about a move without reopening the conversation or marking it read', async () => {
    const c = customer('Rita');
    const booked = await bookOnline(w, cal.slug, at(7, '10:00'), {
      ...c,
      smsConsent: true,
      ...AT_HOME,
    });
    await drain(w);
    const attendee = await attendeeByToken(booked.manageToken);
    // The customer wrote in, and nobody has answered yet.
    await rows(
      admin(),
      sql`update app.conversations set status = 'open', unread_count = 2,
            awaiting_reply_since = now() - interval '5 minutes'
          where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    const later = at(7, '14:00');
    await run(w, appointmentReschedule, {
      workspaceId: w.workspaceId,
      appointmentId: attendee.appointment_id,
      startsAt: iso(later),
    });
    await drain(w);
    const texts = textsTo(w, c.phone);
    expect(texts.at(-1)!.body).toBe(
      `${BUSINESS}: Your AC tune-up is now ${dayShort(later, CHI)} at 2:00 PM CT. Change or cancel: http://localhost:3000/m/${booked.manageToken}`,
    );
    const [conv] = await rows<{ status: string; unread_count: number; waiting: boolean }>(
      admin(),
      sql`select status::text as status, unread_count, awaiting_reply_since is not null as waiting
          from app.conversations where workspace_id = ${w.workspaceId} and counterpart = ${c.phone}`,
    );
    expect(conv).toEqual({ status: 'open', unread_count: 2, waiting: true });

    // Moved quietly: nothing sent.
    await run(w, appointmentReschedule, {
      workspaceId: w.workspaceId,
      appointmentId: attendee.appointment_id,
      startsAt: iso(at(7, '15:00')),
      notify: false,
    });
    await drain(w);
    expect(textsTo(w, c.phone)).toHaveLength(texts.length);

    // People's messages always reopen their conversation.
    await expect(
      run(w, messageSend, {
        workspaceId: w.workspaceId,
        toPhone: c.phone,
        body: 'On our way',
        keepConversationStatus: true,
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('a calendar with no staff', () => {
  it('confirms without naming anyone, emails the calendar’s owner (else the owners and admins), and writes to nobody’s calendar', async () => {
    const { resourceId } = await run(w, resourceCreate, {
      workspaceId: w.workspaceId,
      name: 'Red light bed',
      kind: 'equipment',
      quantity: 4,
    });
    const beds = await makeCalendar(w, 'Red light session', {
      team: { members: [], assignment: 'none' },
      resources: { required: [{ resourceId }] },
      durations: { minutes: [20], step: 10 },
      buffers: { after: 10 },
    });
    // Dale's own calendar is connected: a booking he worked would be written into it.
    const [conn] = await rows<{ id: string }>(
      admin(),
      sql`insert into app.calendar_connections (workspace_id, user_id, provider, status, created_by)
          values (${w.workspaceId}, ${w.owner.id}, 'google', 'active', ${w.owner.id}) returning id`,
    );
    try {
      const start = at(8, '10:00');
      const texted = customer('Ava');
      const booked = await bookOnline(w, beds.slug, start, { ...texted, smsConsent: true });
      await drain(w);
      expect(textsTo(w, texted.phone).at(-1)!.body).toBe(
        `${BUSINESS}: You're booked for a red light session on ${dayShort(start, CHI)} at 10:00 AM CT. Change or cancel: http://localhost:3000/m/${booked.manageToken} Reply STOP to opt out.`,
      );
      const team = await waitForMail(
        w.owner.email,
        `New booking: Ava Customer, Red light session, ${weekdayShort(start, CHI)} 10:00 AM`,
      );
      expect(team.text).toContain('Ava Customer booked a red light session online.');
      const attendee = await attendeeByToken(booked.manageToken);
      const [sync] = await rows<{ n: number }>(
        admin(),
        sql`select count(*)::int as n from app.scheduled_jobs
            where kind = 'appointment.calendar_sync' and payload ->> 'appointmentId' = ${attendee.appointment_id}`,
      );
      expect(sync!.n).toBe(0);

      // With no owner on the calendar, the workspace's owners and admins hear; by email, no "Who" line.
      await rows(admin(), sql`update app.calendars set owner_user_id = null where id = ${beds.id}`);
      const emailed = customer('Ben');
      await bookOnline(w, beds.slug, at(8, '11:00'), { ...emailed, smsConsent: false });
      await drain(w);
      const confirmation = await waitForMail(emailed.email, 'You’re booked: Red light session');
      expect(confirmation.text).toContain('What: Red light session · 20 min');
      expect(confirmation.text).not.toContain('Who:');
      const heads = await waitForMail(
        w.owner.email,
        'New booking: Ben Customer, Red light session',
      );
      expect(heads.text).toContain('Ben Customer booked a red light session online.');
    } finally {
      await rows(admin(), sql`delete from app.calendar_connections where id = ${conn!.id}`);
    }
  });
});
