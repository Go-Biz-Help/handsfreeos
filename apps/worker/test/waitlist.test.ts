/**
 * The waitlist on the real database, through the public routes: a freed seat in a session books the oldest
 * waiting customer that fits (and tells them), a seat moved to another session gets a notice with its new
 * link, and a freed 1:1 time is offered with a link that shows it, books it once, runs out to the next person,
 * and keeps someone's place when another customer took the time first.
 */
import { sessionPublish } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { offerExpireKey } from '../src/booking/waitlist';
import { dayShort } from '../src/booking/when';
import {
  admin,
  at,
  bookOnline,
  CHI,
  customer,
  drain,
  errorOf,
  get,
  HOUR,
  iso,
  MIN,
  makeCalendar,
  makeWorld,
  post,
  run,
  runDue,
  waitForMail,
  type World,
} from './booking-world';

let w: World;
let classes: { id: string; slug: string };
let line: { id: string; slug: string };

beforeAll(async () => {
  // No texting: everything goes by email, into Mailpit.
  w = await makeWorld('wl');
  classes = await makeCalendar(w, 'Homeowner class', {
    schedule: { mode: 'sessions' },
    capacity: { seats: 2, maxPartySize: 2 },
    waitlist: { enabled: true },
  });
  line = await makeCalendar(w, 'Tune-up line', { waitlist: { enabled: true, offerMinutes: 60 } });
});
afterAll(async () => {
  await w.app.close();
  await closeTestDbs();
});

const publish = async (start: number) =>
  (
    await run(w, sessionPublish, {
      workspaceId: w.workspaceId,
      calendarId: classes.id,
      startsAt: iso(start),
      userIds: [w.owner.id],
    })
  ).appointmentId;

const entryOf = async (email: string) =>
  (
    await rows<{ id: string; status: string; offer: Record<string, unknown> | null }>(
      admin(),
      sql`select id, status::text as status, offer from app.waitlist_entries where contact_email = ${email}`,
    )
  )[0]!;

/** The offer link in the newest "A time opened" email to them. */
async function offerLink(email: string): Promise<string> {
  const mail = await waitForMail(email, 'A time opened:');
  return /http:\/\/localhost:3000\/w\/([0-9A-Za-z]{18})/.exec(mail.text)![1]!;
}

async function joinWaitlist(slug: string, body: Record<string, unknown>) {
  const res = await post(w, `/public/book/${w.site}/${slug}/waitlist`, body);
  expect(res.statusCode, res.body).toBe(200);
}

describe('sessions', () => {
  it('books the oldest waiting customer that fits into a freed seat, and tells them', async () => {
    const start = at(3, '10:00');
    const session = await publish(start);
    const ann = await bookOnline(w, classes.slug, start, {
      ...customer('Ann'),
      sessionId: session,
    });
    await bookOnline(w, classes.slug, start, { ...customer('Ben'), sessionId: session });
    // Full: the first to wait wants two seats, the second one.
    const pair = customer('Pat');
    const solo = customer('Sol');
    await joinWaitlist(classes.slug, { ...pair, sessionId: session, partySize: 2 });
    await joinWaitlist(classes.slug, { ...solo, sessionId: session });
    await drain(w);

    // Ann gives up her seat: one opens, and only Sol fits.
    expect((await post(w, `/public/manage/${ann.manageToken}/cancel`, {})).statusCode).toBe(200);
    await drain(w);
    expect((await entryOf(pair.email)).status).toBe('waiting');
    expect((await entryOf(solo.email)).status).toBe('booked');
    const [seat] = await rows<{ status: string }>(
      admin(),
      sql`select a.status::text as status from app.appointment_attendees a
          where a.appointment_id = ${session} and a.contact_email = ${solo.email}`,
    );
    expect(seat).toEqual({ status: 'booked' });
    const mail = await waitForMail(solo.email, 'You’re booked: Homeowner class');
    expect(mail.text).toContain('A seat opened, so you’re booked, Sol.');
    await waitForMail(w.owner.email, 'New booking: Sol Customer, Homeowner class');
  });

  it('moves a seat to another session with a new link, and says so', async () => {
    const first = at(4, '10:00');
    const second = at(5, '10:00');
    const s1 = await publish(first);
    const s2 = await publish(second);
    const c = customer('Mo');
    const booked = await bookOnline(w, classes.slug, first, { ...c, sessionId: s1 });
    const res = await post(w, `/public/manage/${booked.manageToken}/reschedule`, {
      startsAt: iso(second),
      sessionId: s2,
    });
    expect(res.statusCode, res.body).toBe(200);
    const moved = res.json() as { manageToken: string; newLink: boolean };
    expect(moved.newLink).toBe(true);
    await drain(w);
    const mail = await waitForMail(c.email, 'Moved: Homeowner class is now');
    expect(mail.text).toContain(`Change or cancel: http://localhost:3000/m/${moved.manageToken}`);
    expect(mail.text).not.toContain(booked.manageToken);
  });
});

describe('offers for a freed 1:1 time', () => {
  it('offers nothing while the business has "Waitlist slot opened" off in Settings → Automations', async () => {
    const setWaitlist = (on: boolean) =>
      rows(
        admin(),
        sql`update app.workspaces
            set settings = jsonb_set(settings, '{automations}',
              ${JSON.stringify({ switches: { waitlist: on } })}::jsonb)
            where id = ${w.workspaceId}`,
      );
    const t = at(6, '14:00');
    const quin = customer('Quin');
    try {
      const pam = await bookOnline(w, line.slug, t, customer('Pam'));
      await joinWaitlist(line.slug, {
        ...quin,
        wantedFrom: iso(t - HOUR),
        wantedTo: iso(t + 2 * HOUR),
      });
      await drain(w);
      await setWaitlist(false);
      expect((await post(w, `/public/manage/${pam.manageToken}/cancel`, {})).statusCode).toBe(200);
      await drain(w);
      // Still waiting, with no offer: the time is simply open for anyone to book.
      expect(await entryOf(quin.email)).toMatchObject({ status: 'waiting', offer: null });
    } finally {
      await rows(
        admin(),
        sql`update app.workspaces set settings = settings - 'automations' where id = ${w.workspaceId}`,
      );
      // Leave the calendar as the next tests expect: Quin off the list.
      await rows(
        admin(),
        sql`update app.waitlist_entries set status = 'removed' where contact_email = ${quin.email}`,
      );
    }
  });

  it('offers it to the next person waiting; the link shows it and books it once', async () => {
    const t = at(3, '14:00');
    const hal = await bookOnline(w, line.slug, t, customer('Hal'));
    const ivy = customer('Ivy');
    await joinWaitlist(line.slug, {
      ...ivy,
      wantedFrom: iso(t - HOUR),
      wantedTo: iso(t + 2 * HOUR),
    });
    await drain(w);
    expect((await post(w, `/public/manage/${hal.manageToken}/cancel`, {})).statusCode).toBe(200);
    await drain(w);

    const entry = await entryOf(ivy.email);
    expect(entry.status).toBe('offered');
    expect(entry.offer).toMatchObject({ startsAt: iso(t), durationMinutes: 60 });
    const [held] = await rows<{ offer_expires_at: Date }>(
      admin(),
      sql`select offer_expires_at from app.waitlist_entries where id = ${entry.id}`,
    );
    expect(new Date(held!.offer_expires_at).getTime()).toBeGreaterThan(Date.now() + 55 * MIN);
    const mail = await waitForMail(
      ivy.email,
      `A time opened: Tune-up line on ${dayShort(t, CHI)} at 2:00 PM`,
    );
    expect(mail.text).toContain('We’re holding it for you until');
    const link = await offerLink(ivy.email);

    expect((await get(w, `/public/waitlist/${link}`)).json()).toMatchObject({
      state: 'offered',
      calendar: { name: 'Tune-up line' },
      offer: { title: 'Tune-up line', startsAt: iso(t), durationMinutes: 60 },
    });
    const claimed = await post(w, `/public/waitlist/${link}/claim`, {});
    expect(claimed.statusCode, claimed.body).toBe(200);
    const view = claimed.json() as { manageToken: string; duplicate: boolean };
    expect(claimed.json()).toMatchObject({
      state: 'booked',
      appointment: { startsAt: iso(t) },
      duplicate: false,
    });
    const again = await post(w, `/public/waitlist/${link}/claim`, {});
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ duplicate: true, manageToken: view.manageToken });
    expect((await get(w, `/public/waitlist/${link}`)).json()).toMatchObject({
      state: 'booked',
      manageToken: view.manageToken,
    });
    const [count] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.appointments
          where calendar_id = ${line.id} and status = 'scheduled' and starts_at = ${iso(t)}::timestamptz`,
    );
    expect(count!.n).toBe(1);
    expect((await entryOf(ivy.email)).status).toBe('booked');
    await drain(w);
    await waitForMail(ivy.email, 'You’re booked: Tune-up line');
  });

  it('moves a run-out offer to the next person, and keeps someone’s place when the time was taken', async () => {
    const t = at(4, '14:00');
    const jo = await bookOnline(w, line.slug, t, customer('Jo'));
    const kim = customer('Kim');
    const lou = customer('Lou');
    for (const c of [kim, lou])
      await joinWaitlist(line.slug, { ...c, wantedFrom: iso(t - HOUR), wantedTo: iso(t + HOUR) });
    await drain(w);
    expect((await post(w, `/public/manage/${jo.manageToken}/cancel`, {})).statusCode).toBe(200);
    await drain(w);
    const kimEntry = await entryOf(kim.email);
    expect(kimEntry.status).toBe('offered');
    expect((await entryOf(lou.email)).status).toBe('waiting');
    const kimLink = await offerLink(kim.email);

    // Kim's hour passes: a claim now is too late, and then the time goes to Lou.
    await rows(
      admin(),
      sql`update app.waitlist_entries set offer_expires_at = now() - interval '1 minute' where id = ${kimEntry.id}`,
    );
    const late = await post(w, `/public/waitlist/${kimLink}/claim`, {});
    expect(late.statusCode).toBe(410);
    expect(errorOf(late).rule).toBe('offer_expired');
    await runDue(w, [offerExpireKey(kimEntry.id)]);
    expect((await entryOf(kim.email)).status).toBe('expired');
    expect((await entryOf(lou.email)).status).toBe('offered');
    expect((await get(w, `/public/waitlist/${kimLink}`)).json()).toMatchObject({
      state: 'expired',
    });

    // Someone books Lou's time on the page first.
    const louLink = await offerLink(lou.email);
    await bookOnline(w, line.slug, t, customer('Max'));
    expect((await get(w, `/public/waitlist/${louLink}`)).json()).toMatchObject({ state: 'taken' });
    const taken = await post(w, `/public/waitlist/${louLink}/claim`, {});
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken).rule).toBe('slot_taken');

    // Lou's hold ends: the time was taken, so Lou waits again instead of losing their place.
    const louEntry = await entryOf(lou.email);
    await rows(
      admin(),
      sql`update app.waitlist_entries set offer_expires_at = now() - interval '1 minute' where id = ${louEntry.id}`,
    );
    await runDue(w, [offerExpireKey(louEntry.id)]);
    expect((await entryOf(lou.email)).status).toBe('waiting');
  });
});
