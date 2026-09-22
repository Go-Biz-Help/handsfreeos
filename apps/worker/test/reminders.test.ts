/**
 * Appointment reminders on the real database with the fake carrier and Mailpit, run through the worker's
 * test route (each job as of when it was due): both reminders armed on booking, an early run that waits,
 * each sent once (even after a lost record), a cancel that stops them, a reschedule that re-arms them, quiet
 * hours shifting a text or sending email instead (or skipping it), and email for a number that said STOP.
 */
import { formatPhone } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reminderJobKey } from '../src/booking/reminders';
import { clock, dayLong, dayShort } from '../src/booking/when';
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
  hh,
  HOUR,
  hourNow,
  iso,
  jobRow,
  makeCalendar,
  makeWorld,
  post,
  readyTexting,
  runDue,
  setQuietHours,
  stateOf,
  textsTo,
  waitForMail,
  type World,
} from './booking-world';

let w: World;
let cal: { id: string; slug: string };
let phoneDisplay: string;

beforeAll(async () => {
  w = await makeWorld('rem');
  phoneDisplay = formatPhone(await readyTexting(w));
  cal = await makeCalendar(w, 'AC tune-up', {
    locations: { options: [{ kind: 'customer_address' }] },
  });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const keys = (attendeeId: string) => ({
  day: reminderJobKey(attendeeId, 'day_before'),
  two: reminderJobKey(attendeeId, 'before_120'),
});
const runAt = async (key: string) => new Date((await jobRow(key))!.run_at).getTime();

async function bookAt(start: number, first: string, extra: Record<string, unknown> = {}) {
  const c = { ...customer(first), ...extra } as ReturnType<typeof customer>;
  const booked = await bookOnline(w, cal.slug, start, { ...c, smsConsent: true, ...AT_HOME });
  await drain(w);
  const attendee = await attendeeByToken(booked.manageToken);
  return { c, booked, attendeeId: attendee.id, k: keys(attendee.id) };
}

describe('appointment reminders', () => {
  it('arms both, waits when run early, then sends each once at its time', async () => {
    const start = at(3, '10:00');
    const { c, attendeeId, k } = await bookAt(start, 'Mike');
    const dayDue = at(2, '16:00');
    expect(await runAt(k.day)).toBe(dayDue);
    expect(await runAt(k.two)).toBe(start - 2 * HOUR);

    // A run before its time only waits again.
    await rows(
      admin(),
      sql`update app.scheduled_jobs set run_at = now() where dedupe_key = ${k.day} and status = 'pending'`,
    );
    await drain(w);
    expect(await runAt(k.day)).toBe(dayDue);
    expect(textsTo(w, c.phone)).toHaveLength(1); // the confirmation

    await runDue(w, [k.day, k.two]);
    const texts = textsTo(w, c.phone).map((t) => t.body);
    expect(texts).toHaveLength(3);
    expect(texts.slice(1)).toEqual(
      expect.arrayContaining([
        `Reminder from ${BUSINESS}: your AC tune-up is tomorrow, ${dayShort(start, CHI)} at 10:00 AM. Dale is coming to 123 Main St. Reply C to confirm.`,
        `${BUSINESS}: Dale is coming today at 10:00 AM for your AC tune-up. Questions? Call ${phoneDisplay}.`,
      ]),
    );
    const state = await stateOf(attendeeId);
    expect(state.reminders['day_before']).toMatchObject({
      status: 'sent',
      channel: 'sms',
      startsAt: iso(start),
    });
    expect(state.reminders['before_120']).toMatchObject({ status: 'sent', channel: 'sms' });

    // Again, as a retry would: once with the record in place, once with it lost after sending.
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, 'appointment.reminder', ${k.day},
            ${iso(dayDue)}::timestamptz, ${JSON.stringify({ attendeeId, key: 'day_before' })}::jsonb)`,
    );
    await runDue(w, [k.day]);
    expect(textsTo(w, c.phone)).toHaveLength(3);
    await rows(
      admin(),
      sql`update app.appointment_attendees
          set reminder_state = jsonb_set(reminder_state, '{reminders,day_before,status}', '"scheduled"')
          where id = ${attendeeId}`,
    );
    await rows(
      admin(),
      sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
          values (${w.organizationId}, ${w.workspaceId}, 'appointment.reminder', ${k.day},
            ${iso(dayDue)}::timestamptz, ${JSON.stringify({ attendeeId, key: 'day_before' })}::jsonb)`,
    );
    await runDue(w, [k.day]);
    expect(textsTo(w, c.phone)).toHaveLength(3);
    expect((await stateOf(attendeeId)).reminders['day_before']).toMatchObject({
      status: 'sent',
      channel: 'sms',
    });
  });

  it('sends nothing for a cancelled booking, and records why', async () => {
    const { c, booked, attendeeId, k } = await bookAt(at(4, '10:00'), 'Carl');
    expect((await post(w, `/public/manage/${booked.manageToken}/cancel`, {})).statusCode).toBe(200);
    await drain(w);
    const sent = textsTo(w, c.phone).length; // the confirmation and the cancel notice
    await runDue(w, [k.day, k.two]);
    expect(textsTo(w, c.phone)).toHaveLength(sent);
    const state = await stateOf(attendeeId);
    expect(state.reminders['day_before']).toMatchObject({ status: 'skipped', reason: 'cancelled' });
    expect(state.reminders['before_120']).toMatchObject({ status: 'skipped', reason: 'cancelled' });
  });

  it('re-arms on a reschedule: a later time waits, a sooner one moves the job up', async () => {
    const first = at(5, '10:00');
    const { c, booked, attendeeId, k } = await bookAt(first, 'Rosa');
    const later = at(6, '13:00');
    const moved = await post(w, `/public/manage/${booked.manageToken}/reschedule`, {
      startsAt: iso(later),
    });
    expect(moved.statusCode, moved.body).toBe(200);
    await drain(w);
    // The job keeps its earlier time; the record says when it goes now.
    expect(await runAt(k.day)).toBe(at(4, '16:00'));
    expect((await stateOf(attendeeId)).reminders['day_before']).toMatchObject({
      status: 'scheduled',
      startsAt: iso(later),
      dueAt: iso(at(5, '16:00')),
    });
    // At the old time it only waits for the new one.
    const sent = textsTo(w, c.phone).length;
    await runDue(w, [k.day]);
    expect(textsTo(w, c.phone)).toHaveLength(sent);
    expect(await runAt(k.day)).toBe(at(5, '16:00'));
    // At the new time it goes, about the new start.
    await runDue(w, [k.day]);
    expect(textsTo(w, c.phone).at(-1)!.body).toBe(
      `Reminder from ${BUSINESS}: your AC tune-up is tomorrow, ${dayShort(later, CHI)} at 1:00 PM. Dale is coming to 123 Main St. Reply C to confirm.`,
    );

    // Moved sooner: the 2-hour job moves up with it.
    const sooner = at(5, '09:00');
    const again = await post(w, `/public/manage/${booked.manageToken}/reschedule`, {
      startsAt: iso(sooner),
    });
    expect(again.statusCode, again.body).toBe(200);
    await drain(w);
    expect(await runAt(k.two)).toBe(sooner - 2 * HOUR);
  });

  it('moves a text past quiet hours when there is time, else emails it at its time, else skips it', async () => {
    // A start hour whose 2-hour reminder is well away from now's clock, so the texts that do go never meet
    // quiet hours themselves.
    const now = hourNow();
    const H = [9, 11, 13, 15, 17, 19].find((h) => now < h - 4 || now > h + 1)!;
    try {
      // Quiet until an hour before the start: the text waits for the end of quiet hours.
      await setQuietHours(w, { start: hh(H - 3), end: hh(H - 1) });
      const s1 = at(8, hh(H));
      const one = await bookAt(s1, 'Ada');
      await runDue(w, [one.k.two]);
      expect((await stateOf(one.attendeeId)).reminders['before_120']).toMatchObject({
        status: 'scheduled',
        channel: 'sms',
        reason: 'quiet_hours',
        dueAt: iso(s1 - HOUR),
      });
      expect(await runAt(one.k.two)).toBe(s1 - HOUR);
      const sent = textsTo(w, one.c.phone).length;
      await runDue(w, [one.k.two]);
      expect(textsTo(w, one.c.phone)).toHaveLength(sent + 1);
      expect(textsTo(w, one.c.phone).at(-1)!.body).toContain(
        `Dale is coming today at ${clock(s1, CHI)} for your AC tune-up.`,
      );

      // Quiet until 30 minutes before: too late to wait, so it goes by email at its time.
      await setQuietHours(w, { start: hh(H - 3), end: `${String(H - 1).padStart(2, '0')}:30` });
      const s2 = at(9, hh(H));
      const two = await bookAt(s2, 'Bea');
      await runDue(w, [two.k.two]);
      const mail = await waitForMail(
        two.c.email,
        `Reminder: AC tune-up today at ${clock(s2, CHI)}`,
      );
      expect(mail.text).toContain('Sent by email because it’s too early to text.');
      expect((await stateOf(two.attendeeId)).reminders['before_120']).toMatchObject({
        status: 'sent',
        channel: 'email',
        reason: 'quiet_hours',
      });

      // No email to fall back on: skipped, and why is kept.
      const s3 = at(10, hh(H));
      const three = await bookAt(s3, 'Cy', { email: '' });
      await runDue(w, [three.k.two]);
      expect((await stateOf(three.attendeeId)).reminders['before_120']).toMatchObject({
        status: 'skipped',
        reason: 'quiet_hours',
      });
    } finally {
      await setQuietHours(w, null);
    }
  });

  it('emails the reminders of a number that texted STOP', async () => {
    const start = at(11, '10:00');
    const one = await bookAt(start, 'Olga');
    await rows(
      admin(),
      sql`insert into app.opt_outs (workspace_id, counterpart_e164, opted_out, source, opted_out_at)
          values (${w.workspaceId}, ${one.c.phone}, true, 'keyword', now())`,
    );
    const sent = textsTo(w, one.c.phone).length;
    await runDue(w, [one.k.day]);
    expect(textsTo(w, one.c.phone)).toHaveLength(sent);
    const mail = await waitForMail(one.c.email, 'Reminder: AC tune-up tomorrow at 10:00 AM');
    expect(mail.text).toContain(
      `Hi Olga, your AC tune-up is tomorrow, ${dayLong(start, CHI)}, 10:00–11:00 AM Central Time, at 123 Main St, Houston, TX 77002. Dale is coming.`,
    );
    expect(mail.text).toContain('Sent by email because Olga asked us not to text.');
    expect((await stateOf(one.attendeeId)).reminders['day_before']).toMatchObject({
      status: 'sent',
      channel: 'email',
      reason: 'opted_out',
    });
  });

  it('skips each reminder the business turned off in Settings → Automations, read when it is due', async () => {
    const setSwitches = (switches: Record<string, boolean>) =>
      rows(
        admin(),
        sql`update app.workspaces
            set settings = jsonb_set(settings, '{automations}', ${JSON.stringify({ switches })}::jsonb)
            where id = ${w.workspaceId}`,
      );
    try {
      // Off when booked, back on before it's due: the day-before one still goes.
      await setSwitches({ dayBefore: false, dayOf: false });
      const { c, attendeeId, k } = await bookAt(at(12, '10:00'), 'Nina');
      const sent = textsTo(w, c.phone).length; // the confirmation
      await setSwitches({ dayBefore: true, dayOf: false });
      await runDue(w, [k.day, k.two]);
      const texts = textsTo(w, c.phone).map((t) => t.body);
      expect(texts).toHaveLength(sent + 1);
      expect(texts.at(-1)).toContain('is tomorrow');
      const state = await stateOf(attendeeId);
      expect(state.reminders['day_before']).toMatchObject({ status: 'sent', channel: 'sms' });
      expect(state.reminders['before_120']).toMatchObject({
        status: 'skipped',
        reason: 'reminders_off',
      });
    } finally {
      await rows(
        admin(),
        sql`update app.workspaces set settings = settings - 'automations' where id = ${w.workspaceId}`,
      );
    }
  });
});
