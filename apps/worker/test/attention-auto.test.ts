/**
 * M8 step 6 on the real database: what HandsFreeOS does on its own. A confirmation request for tomorrow's
 * booking and a follow-up nudge for a lead gone quiet go out after their cancel window — once, to someone who can
 * be reached, never in quiet hours, never over a person or Ava, and never before an owner has read the nudge. Every
 * skip says why. Then the end to end: the request goes out, the customer replies C, and the item clears.
 */
import { randomUUID } from 'node:crypto';
import {
  attentionCancelAuto,
  attentionSaveSettings,
  executeCommand,
  messageReceive,
  messageSend,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { onConfirmedThanks } from '../src/handlers/appointment-messages';
import { handlers } from '../src/handlers/index';
import { handlersFor } from '../src/handlers/types';
import { systemActor } from '../src/services';
import {
  attentionWorld,
  filedCustomer,
  itemOf,
  runSweep,
  typedLead,
  type AttentionWorld,
  type ItemRow,
} from './attention-world';
import {
  admin,
  at,
  AT_HOME,
  attendeeByToken,
  bookOnline,
  customer,
  drain,
  emailsTo,
  hh,
  hourNow,
  iso,
  makeCalendar,
  MIN,
  post,
  run,
  setQuietHours,
  textsTo,
} from './booking-world';

let w: AttentionWorld;
let cal: { id: string; slug: string };

beforeAll(async () => {
  w = await attentionWorld('attnauto');
  cal = await makeCalendar(w, 'AC tune-up', {
    locations: { options: [{ kind: 'customer_address' }] },
  });
});
afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const scope = () => ({ workspaceId: w.workspaceId, organizationId: w.organizationId });
/** The thank-you on attendee.confirmed, until handlers/index.ts lists it (step 5's gap). */
const withThanks: typeof handlers = handlersFor(handlers, 'attendee.confirmed').includes(
  onConfirmedThanks,
)
  ? handlers
  : {
      ...handlers,
      'attendee.confirmed': [...handlersFor(handlers, 'attendee.confirmed'), onConfirmedThanks],
    };

const saveSettings = (settings: Record<string, unknown>) =>
  run(w, attentionSaveSettings, { workspaceId: w.workspaceId, settings });
const nudgesOn = () =>
  saveSettings({ auto: { confirmRequests: true, nudges: true, nudgeReviewedAt: iso(Date.now()) } });
const nudgesOff = () => saveSettings({ auto: { confirmRequests: true, nudges: false } });

/** Skips the 60-minute cancel window for one item: its message goes out now. */
async function sendNow(itemId: string): Promise<{ scheduled: boolean; moved: number }> {
  const res = await post(w, '/test/attention/send-now', {
    workspaceId: w.workspaceId,
    itemId,
  });
  expect(res.statusCode, res.body).toBe(200);
  await drain(w, undefined, withThanks);
  return res.json() as { scheduled: boolean; moved: number };
}

/**
 * A one-on-one booking tomorrow: inside the 48-hour window, so it needs confirming. The calendar seats one
 * customer at a time, so every test books its own hour.
 */
async function bookTomorrow(first: string, clock: string, extra: Record<string, unknown> = {}) {
  const startsAt = at(1, clock);
  const c = { ...customer(first), ...extra } as ReturnType<typeof customer>;
  const booked = await bookOnline(w, cal.slug, startsAt, {
    ...c,
    smsConsent: true,
    ...AT_HOME,
  });
  await drain(w);
  const { id: attendeeId } = await attendeeByToken(booked.manageToken);
  const [seat] = await rows<{ person_id: string }>(
    admin(),
    sql`select person_id from app.appointment_attendees where id = ${attendeeId}`,
  );
  const item = await itemOf(w, attendeeId, 'unconfirmed_appointment');
  return { c, booked, attendeeId, personId: seat!.person_id, item, startsAt };
}

/** A lead nobody has touched for eight days, with a customer who agreed to texts. */
async function staleLead(name: string, opts: { email?: boolean; optIn?: boolean } = {}) {
  const c = await filedCustomer(w, name);
  if (opts.optIn)
    await rows(admin(), sql`update app.people set sms_consent = 'opted_in' where id = ${c.id}`);
  if (opts.email)
    await rows(
      admin(),
      sql`update app.people set email = ${`${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`}
          where id = ${c.id}`,
    );
  const leadId = await typedLead(w, c.id, `${name}: quote`, { daysAgo: 8, nextActionInDays: 60 });
  await drain(w);
  await runSweep(w);
  return { c, leadId, item: await itemOf(w, leadId, 'stale_opportunity') };
}

const seatOf = async (attendeeId: string) => {
  const [s] = await rows<{ confirm_asked_at: Date | null; confirmed_via: string | null }>(
    admin(),
    sql`select confirm_asked_at, confirmed_via from app.appointment_attendees where id = ${attendeeId}`,
  );
  return s!;
};

const reread = (item: ItemRow, kind: string) => itemOf(w, item.subjectId, kind);

describe('a confirmation request', () => {
  it('waits out the cancel window, then asks once and marks the item handled', async () => {
    const { c, attendeeId, item, startsAt } = await bookTomorrow('Denise', '10:00');
    // Armed for the end of the cancel window, with nothing sent yet.
    expect(item.autoState).toBe('scheduled');
    expect(item.autoScheduledFor!.getTime()).toBeGreaterThan(Date.now() + 55 * MIN);
    expect(item.autoScheduledFor!.getTime()).toBeLessThan(Date.now() + 65 * MIN);
    expect((await seatOf(attendeeId)).confirm_asked_at).toBeNull();
    const before = textsTo(w, c.phone).length;

    await sendNow(item.id);
    const texts = textsTo(w, c.phone);
    expect(texts).toHaveLength(before + 1);
    const asked = texts.at(-1)!.body;
    expect(asked).toContain('Can you confirm your AC tune-up tomorrow');
    expect(asked).toContain('Reply C to confirm.');
    // The ask is open, so a C now confirms; the item is handled until 12 hours before the start.
    expect((await seatOf(attendeeId)).confirm_asked_at).not.toBeNull();
    const done = await reread(item, 'unconfirmed_appointment');
    expect(done).toMatchObject({ state: 'handled', autoState: 'sent', handledVia: 'auto' });
    // Handled until twelve hours before the start — or not held at all when that moment has already
    // passed, which is what happens when the suite runs late in the evening for a visit tomorrow morning.
    const until = startsAt - 12 * 3_600_000;
    expect(done.handledUntil?.getTime() ?? null).toBe(until > Date.now() ? until : null);
    expect(done.autoSkipReason).toBeNull();

    // Run it again, as a retry would: the same message never goes twice.
    await sendNow(item.id);
    expect(textsTo(w, c.phone)).toHaveLength(before + 1);
  });

  it('sends their own booking link when replying C is turned off', async () => {
    await saveSettings({ replyToConfirm: false, auto: { confirmRequests: true } });
    try {
      const { c, item, booked } = await bookTomorrow('Elena', '11:00');
      const before = textsTo(w, c.phone).length;
      await sendNow(item.id);
      const asked = textsTo(w, c.phone).at(-1)!.body;
      expect(textsTo(w, c.phone)).toHaveLength(before + 1);
      expect(asked).not.toContain('Reply C');
      expect(asked).toContain(booked.manageUrl);
      expect(asked).not.toContain('[their booking link]');
    } finally {
      await saveSettings({ replyToConfirm: true, auto: { confirmRequests: true } });
    }
  });

  it('holds a text for quiet hours instead of sending it', async () => {
    // Long enough that quiet hours still have hours to run when the cancel window ends, whatever time it is.
    const hour = hourNow();
    await setQuietHours(w, { start: hh(hour), end: hh(hour + 6) });
    try {
      const { c, item } = await bookTomorrow('Farah', '12:00');
      // It is armed for the end of quiet hours, not the plain cancel window.
      expect(item.autoScheduledFor!.getTime()).toBeGreaterThan(Date.now() + 65 * MIN);
      const before = textsTo(w, c.phone).length;
      await sendNow(item.id);
      expect(textsTo(w, c.phone)).toHaveLength(before);
      expect((await reread(item, 'unconfirmed_appointment')).autoState).toBe('scheduled');
    } finally {
      await setQuietHours(w, null);
    }
  });

  it('goes by email when the customer has texted STOP', async () => {
    const { c, item } = await bookTomorrow('Gita', '13:00');
    await rows(
      admin(),
      sql`insert into app.opt_outs (workspace_id, counterpart_e164, opted_out, source, opted_out_at)
          values (${w.workspaceId}, ${c.phone}, true, 'keyword', now())`,
    );
    const before = textsTo(w, c.phone).length;
    await sendNow(item.id);
    expect(textsTo(w, c.phone)).toHaveLength(before);
    expect(await emailsTo(w, c.email)).toContainEqual(
      expect.stringContaining('Please confirm: AC tune-up'),
    );
    expect((await reread(item, 'unconfirmed_appointment')).autoState).toBe('sent');
  });

  it('leaves it to a person who has just messaged them', async () => {
    const { c, item, personId } = await bookTomorrow('Hana', '14:00');
    await run(w, messageSend, {
      workspaceId: w.workspaceId,
      personId,
      body: 'Hi Hana, Dale here. See you tomorrow!',
    });
    await drain(w);
    const before = textsTo(w, c.phone).length;
    await sendNow(item.id);
    expect(textsTo(w, c.phone)).toHaveLength(before);
    expect(await reread(item, 'unconfirmed_appointment')).toMatchObject({
      autoState: 'skipped',
      autoSkipReason: 'recent_person_contact',
    });
  });

  it('answers the customer first when they are waiting on a reply', async () => {
    const { c, item } = await bookTomorrow('Ines', '15:00');
    await executeCommand(
      testDbs().worker.db,
      messageReceive,
      {
        workspaceId: w.workspaceId,
        provider: 'fake',
        providerMessageId: `SM${randomUUID()}`,
        from: c.phone,
        to: w.number!,
        body: 'Quick question about tomorrow',
        reminderAfterMs: 86_400_000,
      },
      systemActor(scope()),
      { correlationId: randomUUID(), channel: 'worker' },
    );
    await drain(w);
    // They wrote in and nobody has answered: HandsFreeOS leaves them to the team rather than talking over it.
    // (Ava handling it, a pending draft and a running workflow are the same check in core's planAutoAction.)
    const before = textsTo(w, c.phone).length;
    await sendNow(item.id);
    expect(textsTo(w, c.phone)).toHaveLength(before);
    expect((await reread(item, 'unconfirmed_appointment')).autoSkipReason).toBe('customer_waiting');
  });

  it('stops when someone cancels it inside the window', async () => {
    const { c, item } = await bookTomorrow('Jo', '16:00');
    await run(w, attentionCancelAuto, { workspaceId: w.workspaceId, itemId: item.id });
    const before = textsTo(w, c.phone).length;
    const ran = await sendNow(item.id);
    expect(ran.scheduled).toBe(false);
    expect(textsTo(w, c.phone)).toHaveLength(before);
    expect(await reread(item, 'unconfirmed_appointment')).toMatchObject({
      autoState: 'cancelled',
      state: 'open',
    });
  });
});

describe('a follow-up nudge', () => {
  it('is never queued before an owner has read the message', async () => {
    const { item } = await staleLead('Kira', { optIn: true });
    expect(item.autoState).toBeNull();
  });

  it('goes out once nudges are on, and the contact clears the item', async () => {
    await nudgesOn();
    try {
      const { c, leadId, item } = await staleLead('Lena', { optIn: true });
      expect(item.autoState).toBe('scheduled');
      const before = textsTo(w, c.phone).length;
      await sendNow(item.id);
      const sent = textsTo(w, c.phone);
      expect(sent).toHaveLength(before + 1);
      expect(sent.at(-1)!.body).toContain('Just checking in');
      expect(await reread(item, 'stale_opportunity')).toMatchObject({
        autoState: 'sent',
        state: 'handled',
      });

      // The text counts as contact, so the lead is no longer quiet. The item stays handled: it is the record
      // of what HandsFreeOS did, and reconcile never resolves one ("3 handled today" keeps it).
      await runSweep(w);
      const after = await itemOf(w, leadId, 'stale_opportunity');
      expect(after.state).toBe('handled');
      const [lead] = await rows<{ last_contact_at: Date | null }>(
        admin(),
        sql`select last_contact_at from app.leads where id = ${leadId}`,
      );
      expect(lead!.last_contact_at).not.toBeNull();

      // A second automatic message to the same lead waits out the 14-day cooldown.
      await rows(
        admin(),
        sql`update app.leads set next_action_at = now() - interval '2 days' where id = ${leadId}`,
      );
      await runSweep(w);
      const follow = await itemOf(w, leadId, 'missing_next_action');
      expect(follow).toMatchObject({ autoState: 'skipped', autoSkipReason: 'cooldown' });
    } finally {
      await nudgesOff();
    }
  });

  it('records turned_off when the switch goes off after it was queued', async () => {
    await nudgesOn();
    const { c, item } = await staleLead('Mira', { optIn: true });
    expect(item.autoState).toBe('scheduled');
    await nudgesOff();
    const before = textsTo(w, c.phone).length;
    await sendNow(item.id);
    expect(textsTo(w, c.phone)).toHaveLength(before);
    expect((await reread(item, 'stale_opportunity')).autoSkipReason).toBe('turned_off');
  });

  it('says so when there is no way to reach them, and when STOP arrives while it waits', async () => {
    await nudgesOn();
    try {
      // A web-form lead who never agreed to texts and left no address.
      const { item } = await staleLead('Nils');
      expect(item).toMatchObject({ autoState: 'skipped', autoSkipReason: 'no_way_to_reach' });

      // One who did agree, then texted STOP while the message waited.
      const other = await staleLead('Olive', { optIn: true });
      expect(other.item.autoState).toBe('scheduled');
      await rows(
        admin(),
        sql`insert into app.opt_outs (workspace_id, counterpart_e164, opted_out, source, opted_out_at)
            values (${w.workspaceId}, ${other.c.phone}, true, 'keyword', now())`,
      );
      const before = textsTo(w, other.c.phone).length;
      await sendNow(other.item.id);
      expect(textsTo(w, other.c.phone)).toHaveLength(before);
      expect((await reread(other.item, 'stale_opportunity')).autoSkipReason).toBe(
        'no_way_to_reach',
      );
    } finally {
      await nudgesOff();
    }
  });

  it('emails a lead who never agreed to texts but left an address', async () => {
    await nudgesOn();
    try {
      const { c, item } = await staleLead('Pia', { email: true });
      expect(item.autoState).toBe('scheduled');
      const [p] = await rows<{ email: string }>(
        admin(),
        sql`select email::text as email from app.people where id = ${c.id}`,
      );
      await sendNow(item.id);
      expect(await emailsTo(w, p!.email)).toContainEqual(expect.stringContaining('Checking in'));
      expect((await reread(item, 'stale_opportunity')).autoState).toBe('sent');
    } finally {
      await nudgesOff();
    }
  });
});

describe('end to end', () => {
  it('asks tomorrow’s customer to confirm, they reply C, and the item clears', async () => {
    const { c, attendeeId, item } = await bookTomorrow('Rhea', '09:00');
    await sendNow(item.id);
    expect(textsTo(w, c.phone).at(-1)!.body).toContain('Reply C to confirm.');

    const { output } = await executeCommand(
      testDbs().worker.db,
      messageReceive,
      {
        workspaceId: w.workspaceId,
        provider: 'fake',
        providerMessageId: `SM${randomUUID()}`,
        from: c.phone,
        to: w.number!,
        body: 'C',
        reminderAfterMs: 86_400_000,
      },
      systemActor(scope()),
      { correlationId: randomUUID(), channel: 'worker' },
    );
    await drain(w, undefined, withThanks);
    expect(output).toMatchObject({ keyword: 'confirm', confirmedAttendeeIds: [attendeeId] });
    expect((await seatOf(attendeeId)).confirmed_via).toBe('sms');
    expect(textsTo(w, c.phone).at(-1)!.body).toContain("You're confirmed for");
    // It is off the list for good: a handled item is the record of what HandsFreeOS did ("Handled by
    // HandsFreeOS"), so reconcile leaves it alone, and a confirmed booking never comes back.
    const cleared = await reread(item, 'unconfirmed_appointment');
    expect(cleared).toMatchObject({ state: 'handled', autoState: 'sent' });
    await runSweep(w);
    expect((await reread(item, 'unconfirmed_appointment')).state).toBe('handled');
  });
});
