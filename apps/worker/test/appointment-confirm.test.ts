/**
 * Confirming appointments (M8) on the real database with the fake carrier and Mailpit: the day-before reminder's
 * "Reply C to confirm." and its email's Confirm link (one-on-one bookings not yet confirmed, with the business's
 * switch on; the ask recorded once), the manage link's Confirm route (POST only; bad, old, cancelled and past
 * refused; twice changes nothing; a reschedule clears it), the thank-you after a text confirmation (once, never
 * for the button, never in quiet hours), and a C through the carrier's webhook, end to end.
 */
import { randomUUID } from 'node:crypto';
import {
  attentionSaveSettings,
  executeCommand,
  messageReceive,
  sessionPublish,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendConfirmedThanks } from '../src/booking/confirm';
import {
  confirmedThanksText,
  reminderEmail,
  reminderText,
  type Business,
  type Visit,
} from '../src/booking/messages';
import { reminderJobKey } from '../src/booking/reminders';
import { dayShort } from '../src/booking/when';
import { onConfirmedThanks } from '../src/handlers/appointment-messages';
import { handlers } from '../src/handlers/index';
import { handlersFor } from '../src/handlers/types';
import { systemActor } from '../src/services';
import { FAKE_AUTH_TOKEN, fakeSid } from '../src/telephony/fake';
import { twilioSignature } from '../src/telephony/signature';
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
  errorOf,
  get,
  hh,
  hourNow,
  iso,
  makeCalendar,
  makeWorld,
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
import { TEST_PUBLIC_URL } from './helpers';

// ---- The words, on their own ----

const TZ = 'America/Chicago';
/** Fri, Sep 18 2026, 10:00 AM in Chicago; its day-before reminder goes at 4 PM on the 17th. */
const START = Date.parse('2026-09-18T15:00:00Z');
const DAY_BEFORE_4PM = Date.parse('2026-09-17T21:00:00Z');
const MANAGE = 'http://localhost:3000/m/AbCdEfGh0123456789';
const lone: Business = {
  name: 'Lone Star HVAC',
  phone: '+17135550100',
  phoneDisplay: '(713) 555-0100',
  bookingUrl: null,
};
const visit: Visit = {
  title: 'AC tune-up',
  startsAt: START,
  endsAt: START + 3_600_000,
  timeZone: TZ,
  kind: 'booking',
  seats: 1,
  locationKind: 'customer_address',
  address: '2210 Oak St, Houston, TX 77002',
  meetingUrl: null,
  staff: ['Priya'],
};
const dayBefore = {
  reminder: { kind: 'day_before' as const, at: '16:00' },
  visit,
  business: lone,
  firstName: 'Denise',
  now: DAY_BEFORE_4PM,
  manageUrl: MANAGE,
  first: false,
  why: null,
};
const PLAIN =
  'Reminder from Lone Star HVAC: your AC tune-up is tomorrow, Fri, Sep 18 at 10:00 AM. Priya is coming to 2210 Oak St.';

describe('the words', () => {
  it('ends the day-before text with "Reply C to confirm." and gives its email a Confirm link', () => {
    expect(reminderText({ ...dayBefore, askToConfirm: true })).toBe(`${PLAIN} Reply C to confirm.`);
    expect(reminderText({ ...dayBefore, askToConfirm: true, first: true })).toBe(
      `${PLAIN} Reply C to confirm. Reply STOP to opt out.`,
    );
    const email = reminderEmail({ ...dayBefore, askToConfirm: true });
    expect(email.body).toContain(`Will this time work? Confirm here: ${MANAGE}?confirm=1`);
    expect(email.body).toContain(`Change or cancel: ${MANAGE}`);
  });

  it('asks nothing when it isn’t asking, and never in the 2-hour reminder', () => {
    expect(reminderText(dayBefore)).toBe(PLAIN);
    expect(reminderEmail(dayBefore).body).not.toContain('confirm=1');
    const twoHours = {
      ...dayBefore,
      reminder: { kind: 'before' as const, minutes: 120 },
      now: START - 2 * 3_600_000,
      askToConfirm: true,
    };
    expect(reminderText(twoHours)).not.toContain('Reply C');
    expect(reminderEmail(twoHours).body).not.toContain('confirm=1');
  });

  it('never asks anyone to reply YES or CANCEL (the carriers’ START and STOP)', () => {
    for (const body of [
      reminderText({ ...dayBefore, askToConfirm: true, first: true }),
      reminderEmail({ ...dayBefore, askToConfirm: true }).body,
    ])
      expect(body).not.toMatch(/reply (yes|cancel)/i);
  });

  it('thanks a customer who confirmed by text, naming each booking the reply confirmed', () => {
    const base = { timeZone: TZ, now: DAY_BEFORE_4PM, first: false };
    expect(confirmedThanksText({ ...base, startsAt: [START], firstName: 'Denise' })).toBe(
      "Thanks, Denise. You're confirmed for tomorrow at 10:00 AM.",
    );
    expect(confirmedThanksText({ ...base, startsAt: [START], firstName: '' })).toBe(
      "Thanks. You're confirmed for tomorrow at 10:00 AM.",
    );
    expect(
      confirmedThanksText({
        ...base,
        startsAt: [START, START + 2 * 86_400_000 + 4 * 3_600_000],
        firstName: 'Denise',
      }),
    ).toBe("Thanks, Denise. You're confirmed for tomorrow at 10:00 AM and Sun, Sep 20 at 2:00 PM.");
    expect(
      confirmedThanksText({
        ...base,
        now: START - 3_600_000,
        startsAt: [START],
        firstName: 'Denise',
        first: true,
      }),
    ).toBe("Thanks, Denise. You're confirmed for today at 10:00 AM. Reply STOP to opt out.");
  });
});

// ---- On the database ----

let w: World;
let cal: { id: string; slug: string };
let classes: { id: string; slug: string };

beforeAll(async () => {
  w = await makeWorld('cnf');
  await readyTexting(w);
  cal = await makeCalendar(w, 'AC tune-up', {
    locations: { options: [{ kind: 'customer_address' }] },
  });
  classes = await makeCalendar(w, 'Homeowner class', {
    schedule: { mode: 'sessions' },
    capacity: { seats: 4, maxPartySize: 2 },
  });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

/** The worker's handlers with the thank-you on attendee.confirmed (added here until handlers/index.ts lists it). */
const withThanks: typeof handlers = handlersFor(handlers, 'attendee.confirmed').includes(
  onConfirmedThanks,
)
  ? handlers
  : {
      ...handlers,
      'attendee.confirmed': [...handlersFor(handlers, 'attendee.confirmed'), onConfirmedThanks],
    };

const dayKey = (attendeeId: string) => reminderJobKey(attendeeId, 'day_before');
const twoKey = (attendeeId: string) => reminderJobKey(attendeeId, 'before_120');
const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });
const lastText = (phone: string) => textsTo(w, phone).at(-1)?.body;
const confirm = (token: string) => post(w, `/public/manage/${token}/confirm`, {});

/** A one-on-one visit at the customer's house, texts agreed; then the worker's work runs. */
async function bookAt(start: number, first: string, extra: Record<string, unknown> = {}) {
  const c = { ...customer(first), ...extra } as ReturnType<typeof customer>;
  const booked = await bookOnline(w, cal.slug, start, { ...c, smsConsent: true, ...AT_HOME });
  await drain(w);
  const { id } = await attendeeByToken(booked.manageToken);
  return { c, booked, token: booked.manageToken, attendeeId: id };
}

async function seatOf(attendeeId: string) {
  const [s] = await rows<{
    confirmed_at: Date | null;
    confirmed_via: string | null;
    confirm_asked_at: Date | null;
  }>(
    admin(),
    sql`select confirmed_at, confirmed_via, confirm_asked_at from app.appointment_attendees
        where id = ${attendeeId}`,
  );
  return s!;
}

/** How many recorded reminders opened an ask for this booking. */
async function asksRecorded(attendeeId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    admin(),
    sql`select count(*)::int as n from app.events where event_type = 'attendee.reminder_recorded'
        and payload ->> 'attendeeId' = ${attendeeId} and (payload ->> 'askedToConfirm')::boolean`,
  );
  return r!.n;
}

/** A customer's text to the business number (message.receive, as the carrier's webhook runs it); then the work. */
async function textIn(from: string, body: string) {
  const { output } = await executeCommand(
    testDbs().worker.db,
    messageReceive,
    {
      workspaceId: w.workspaceId,
      provider: 'fake',
      providerMessageId: `SM${randomUUID()}`,
      from,
      to: w.number!,
      body,
      reminderAfterMs: 86_400_000,
    },
    systemActor(scope()),
    { correlationId: randomUUID(), channel: 'worker' },
  );
  await drain(w, undefined, withThanks);
  return output;
}

describe('the day-before reminder asks', () => {
  it('asks a one-on-one booking to reply C, and records the ask once', async () => {
    const start = at(3, '10:00');
    const { c, attendeeId } = await bookAt(start, 'Mike');
    expect((await seatOf(attendeeId)).confirm_asked_at).toBeNull();
    await runDue(w, [dayKey(attendeeId)]);
    expect(lastText(c.phone)).toBe(
      `Reminder from ${BUSINESS}: your AC tune-up is tomorrow, ${dayShort(start, CHI)} at 10:00 AM. Dale is coming to 123 Main St. Reply C to confirm.`,
    );
    const asked = (await seatOf(attendeeId)).confirm_asked_at;
    expect(asked).not.toBeNull();
    expect(await asksRecorded(attendeeId)).toBe(1);

    // The 2-hour reminder never asks.
    await runDue(w, [twoKey(attendeeId)]);
    expect(lastText(c.phone)).not.toContain('Reply C');

    // Again, as a retry would: with its record in place, then with the record lost after sending.
    const sent = textsTo(w, c.phone).length;
    const requeue = () =>
      rows(
        admin(),
        sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
            values (${w.organizationId}, ${w.workspaceId}, 'appointment.reminder', ${dayKey(attendeeId)},
              ${iso(at(2, '16:00'))}::timestamptz, ${JSON.stringify({ attendeeId, key: 'day_before' })}::jsonb)`,
      );
    await requeue();
    await runDue(w, [dayKey(attendeeId)]);
    await rows(
      admin(),
      sql`update app.appointment_attendees
          set reminder_state = jsonb_set(reminder_state, '{reminders,day_before,status}', '"scheduled"')
          where id = ${attendeeId}`,
    );
    await requeue();
    await runDue(w, [dayKey(attendeeId)]);
    expect(textsTo(w, c.phone)).toHaveLength(sent);
    expect((await seatOf(attendeeId)).confirm_asked_at).toEqual(asked);
    expect(await asksRecorded(attendeeId)).toBe(1);
  });

  it('by email, the reminder carries a Confirm link to the manage page, and that asks too', async () => {
    const { c, booked, attendeeId } = await bookAt(at(4, '10:00'), 'Olga');
    await rows(
      admin(),
      sql`insert into app.opt_outs (workspace_id, counterpart_e164, opted_out, source, opted_out_at)
          values (${w.workspaceId}, ${c.phone}, true, 'keyword', now())`,
    );
    await runDue(w, [dayKey(attendeeId)]);
    const mail = await waitForMail(c.email, 'Reminder: AC tune-up tomorrow at 10:00 AM');
    expect(mail.text).toContain(`Will this time work? Confirm here: ${booked.manageUrl}?confirm=1`);
    expect(mail.text).toContain(`Change or cancel: ${booked.manageUrl}`);
    expect((await stateOf(attendeeId)).reminders['day_before']).toMatchObject({
      status: 'sent',
      channel: 'email',
    });
    expect((await seatOf(attendeeId)).confirm_asked_at).not.toBeNull();
  });

  it('asks nothing when the business turned “Reply C to confirm” off', async () => {
    await run(w, attentionSaveSettings, {
      workspaceId: w.workspaceId,
      settings: { replyToConfirm: false },
    });
    try {
      const start = at(5, '10:00');
      const { c, attendeeId } = await bookAt(start, 'Nils');
      await runDue(w, [dayKey(attendeeId)]);
      expect(lastText(c.phone)).toBe(
        `Reminder from ${BUSINESS}: your AC tune-up is tomorrow, ${dayShort(start, CHI)} at 10:00 AM. Dale is coming to 123 Main St.`,
      );
      expect((await seatOf(attendeeId)).confirm_asked_at).toBeNull();
    } finally {
      await run(w, attentionSaveSettings, {
        workspaceId: w.workspaceId,
        settings: { replyToConfirm: true },
      });
    }
  });

  it('never asks a seat in a group session, whose manage page offers no Confirm', async () => {
    const start = at(6, '10:00');
    const { appointmentId } = await run(w, sessionPublish, {
      workspaceId: w.workspaceId,
      calendarId: classes.id,
      startsAt: iso(start),
      userIds: [w.owner.id],
    });
    const c = customer('Sol');
    const booked = await bookOnline(w, classes.slug, start, {
      ...c,
      sessionId: appointmentId,
      smsConsent: true,
    });
    await drain(w);
    const { id: attendeeId } = await attendeeByToken(booked.manageToken);
    await runDue(w, [dayKey(attendeeId)]);
    expect((await stateOf(attendeeId)).reminders['day_before']).toMatchObject({
      status: 'sent',
      channel: 'sms',
    });
    expect(lastText(c.phone)).toMatch(/^Reminder from /);
    expect(lastText(c.phone)).not.toContain('Reply C');
    expect((await seatOf(attendeeId)).confirm_asked_at).toBeNull();
    expect((await get(w, `/public/manage/${booked.manageToken}`)).json()).toMatchObject({
      confirmation: null,
    });
    const refused = await confirm(booked.manageToken);
    expect(refused.statusCode).toBe(409);
    expect(errorOf(refused).rule).toBe('confirmation_not_needed');
  });

  it('asks nothing of a booking already confirmed', async () => {
    const start = at(7, '10:00');
    const { c, token, attendeeId } = await bookAt(start, 'Ines');
    expect((await confirm(token)).statusCode).toBe(200);
    await drain(w);
    await runDue(w, [dayKey(attendeeId)]);
    expect(lastText(c.phone)).toBe(
      `Reminder from ${BUSINESS}: your AC tune-up is tomorrow, ${dayShort(start, CHI)} at 10:00 AM. Dale is coming to 123 Main St.`,
    );
    expect((await seatOf(attendeeId)).confirm_asked_at).toBeNull();
  });
});

describe('the Confirm route', () => {
  it('confirms on a POST, never on opening a link, and a second press changes nothing', async () => {
    const { c, token, attendeeId } = await bookAt(at(8, '10:00'), 'Pia');
    const base = `/public/manage/${token}`;
    // Opening the link, as the email's Confirm button (or a mail scanner) does, confirms nothing.
    const opened = await get(w, `${base}?confirm=1`);
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      state: 'booked',
      confirmation: { confirmedAt: null, confirmedVia: null, askedAt: null },
    });
    expect((await get(w, `${base}/confirm`)).statusCode).toBe(404);
    expect((await seatOf(attendeeId)).confirmed_at).toBeNull();

    const pressed = await confirm(token);
    expect(pressed.statusCode, pressed.body).toBe(200);
    expect(pressed.headers['cache-control']).toBe('no-store');
    const body = pressed.json() as {
      confirmation: { confirmedAt: string; confirmedVia: string };
    };
    expect(body).toMatchObject({
      state: 'booked',
      changed: true,
      manageToken: token,
      confirmation: { confirmedVia: 'link', askedAt: null },
    });
    expect(body).not.toHaveProperty('attendeeId');
    const seat = await seatOf(attendeeId);
    expect(seat.confirmed_via).toBe('link');
    expect(body.confirmation.confirmedAt).toBe(new Date(seat.confirmed_at!).toISOString());

    const again = await confirm(token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({
      changed: false,
      confirmation: { confirmedAt: body.confirmation.confirmedAt, confirmedVia: 'link' },
    });
    expect((await get(w, base)).json()).toMatchObject({
      confirmation: { confirmedAt: body.confirmation.confirmedAt, confirmedVia: 'link' },
    });
    const [n] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events where event_type = 'attendee.confirmed'
          and payload ->> 'attendeeId' = ${attendeeId}`,
    );
    expect(n!.n).toBe(1);

    // No thank-you text for a press of the button.
    const sent = textsTo(w, c.phone).length;
    await drain(w, undefined, withThanks);
    expect(textsTo(w, c.phone)).toHaveLength(sent);
  });

  it('refuses bad and old links the way reschedule and cancel do', async () => {
    const { token, attendeeId } = await bookAt(at(8, '13:00'), 'Quinn');
    const last = token.at(-1) === 'a' ? 'b' : 'a';
    for (const bad of [`${token.slice(0, 17)}${last}`, `ZZZZZZZZ${token.slice(8)}`, 'short'])
      expect((await confirm(bad)).statusCode).toBe(404);
    await rows(
      admin(),
      sql`update app.appointment_attendees set manage_version = manage_version + 1 where id = ${attendeeId}`,
    );
    const stale = await confirm(token);
    expect(stale.statusCode).toBe(410);
    expect(errorOf(stale)).toMatchObject({
      rule: 'manage_link_stale',
      details: { business: { name: BUSINESS } },
    });
    expect((await seatOf(attendeeId)).confirmed_at).toBeNull();
  });

  it('refuses cancelled and past bookings', async () => {
    const one = await bookAt(at(9, '10:00'), 'Rae');
    expect((await post(w, `/public/manage/${one.token}/cancel`, {})).statusCode).toBe(200);
    const cancelled = await confirm(one.token);
    expect(cancelled.statusCode).toBe(409);
    expect(errorOf(cancelled).rule).toBe('booking_cancelled');

    const two = await bookAt(at(9, '13:00'), 'Sam');
    const { appointment_id } = await attendeeByToken(two.token);
    await rows(
      admin(),
      sql`update app.appointments set starts_at = now() - interval '2 hours', ends_at = now() - interval '1 hour'
          where id = ${appointment_id}`,
    );
    const past = await confirm(two.token);
    expect(past.statusCode).toBe(409);
    expect(errorOf(past).rule).toBe('appointment_started');
    expect((await seatOf(two.attendeeId)).confirmed_at).toBeNull();
  });

  it('a reschedule clears it, so the new time needs confirming again', async () => {
    const { token, attendeeId } = await bookAt(at(10, '10:00'), 'Tia');
    expect((await confirm(token)).statusCode).toBe(200);
    const moved = await post(w, `/public/manage/${token}/reschedule`, {
      startsAt: iso(at(10, '14:00')),
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({
      state: 'booked',
      confirmation: { confirmedAt: null, confirmedVia: null, askedAt: null },
    });
    expect(await seatOf(attendeeId)).toMatchObject({ confirmed_at: null, confirmed_via: null });
    expect((await confirm(token)).json()).toMatchObject({
      changed: true,
      confirmation: { confirmedVia: 'link' },
    });
  });
});

describe('the thank-you', () => {
  it('thanks a customer who replied C, once', async () => {
    const start = at(11, '10:00');
    const { c, attendeeId } = await bookAt(start, 'Uma');
    await runDue(w, [dayKey(attendeeId)]);
    const got = await textIn(c.phone, 'C');
    expect(got).toMatchObject({ keyword: 'confirm', confirmedAttendeeIds: [attendeeId] });
    expect((await seatOf(attendeeId)).confirmed_via).toBe('sms');
    expect(lastText(c.phone)).toBe(
      `Thanks, Uma. You're confirmed for ${dayShort(start, CHI)} at 10:00 AM.`,
    );
    const sent = textsTo(w, c.phone).length;

    // Run again, as a retried event would: the same reply's thank-you doesn't go twice.
    await sendConfirmedThanks(w.s, scope(), attendeeId, {
      messageId: got.messageId,
      now: Date.now(),
      meta: { correlationId: randomUUID(), channel: 'worker' },
    });
    await drain(w, undefined, withThanks);
    expect(textsTo(w, c.phone)).toHaveLength(sent);
  });

  it('one C that confirms two bookings sends one thank-you naming both', async () => {
    const first = at(12, '10:00');
    const second = at(13, '15:00');
    const one = await bookAt(first, 'Vic');
    const two = await bookAt(second, 'Vic', { phone: one.c.phone });
    await runDue(w, [dayKey(one.attendeeId), dayKey(two.attendeeId)]);
    const sent = textsTo(w, one.c.phone).length;
    const got = await textIn(one.c.phone, 'Confirm');
    expect(got.confirmedAttendeeIds).toEqual([one.attendeeId, two.attendeeId]);
    expect(textsTo(w, one.c.phone)).toHaveLength(sent + 1);
    expect(lastText(one.c.phone)).toBe(
      `Thanks, Vic. You're confirmed for ${dayShort(first, CHI)} at 10:00 AM and ${dayShort(second, CHI)} at 3:00 PM.`,
    );
  });

  it('skips it in quiet hours', async () => {
    const { c, attendeeId } = await bookAt(at(14, '10:00'), 'Wes');
    await runDue(w, [dayKey(attendeeId)]);
    const sent = textsTo(w, c.phone).length;
    const hour = hourNow();
    try {
      await setQuietHours(w, { start: hh(hour), end: hh(hour + 2) });
      await textIn(c.phone, 'c');
      expect((await seatOf(attendeeId)).confirmed_via).toBe('sms');
      expect(textsTo(w, c.phone)).toHaveLength(sent);
    } finally {
      await setQuietHours(w, null);
    }
  });
});

describe('replying C, end to end', () => {
  it('the reminder asks, a C comes through the carrier, and the customer is confirmed and thanked', async () => {
    const start = at(15, '10:00');
    const { c, token, attendeeId } = await bookAt(start, 'Xena');
    await runDue(w, [dayKey(attendeeId)]);
    expect(lastText(c.phone)).toMatch(/ Reply C to confirm\.$/);

    const [account] = await rows<{ account_sid: string }>(
      admin(),
      sql`select account_sid from app.telephony_accounts where workspace_id = ${w.workspaceId}`,
    );
    const path = '/webhooks/twilio/messaging/inbound';
    const params = {
      AccountSid: account!.account_sid,
      MessageSid: fakeSid('SM'),
      From: c.phone,
      To: w.number!,
      Body: 'C',
    };
    const res = await w.app.inject({
      method: 'POST',
      url: path,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': twilioSignature(FAKE_AUTH_TOKEN, `${TEST_PUBLIC_URL}${path}`, params),
      },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode, res.body).toBe(200);
    await drain(w, undefined, withThanks);

    expect((await seatOf(attendeeId)).confirmed_via).toBe('sms');
    expect(lastText(c.phone)).toBe(
      `Thanks, Xena. You're confirmed for ${dayShort(start, CHI)} at 10:00 AM.`,
    );
    expect((await get(w, `/public/manage/${token}`)).json()).toMatchObject({
      confirmation: { confirmedVia: 'sms', askedAt: expect.any(String) },
    });
  });
});
