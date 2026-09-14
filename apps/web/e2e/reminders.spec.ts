/**
 * Customer messages end to end on the fake carrier and Mailpit. Customers book online; the worker's test route
 * then runs their reminder jobs as of when each was due (days from now), and the day-before and 2-hour
 * reminders arrive: by text for a customer who agreed to texts, by email only for one whose number texted
 * STOP, and not at all for an appointment that was cancelled. Then a waitlist offer's link books its time.
 */
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, makeCalendar, ownerWithSite, WORKER, type Owner } from './booking-helpers';
import { MAILPIT, waitForMail } from './helpers';
import { setUpTexting, textFromCustomer } from './telephony';

const DAY = 86_400_000;
const HOUR = 3_600_000;

interface Entry {
  status: string;
  channel: string | null;
  reason: string | null;
  messageId: string | null;
}
interface Attendee {
  id: string;
  reminders: { confirmation: Entry | null; reminders: Record<string, Entry> };
}

/** Today plus `days` at 15:00 UTC (a morning in Chicago). */
function daysAt(days: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}

const phone = () => `+1713555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const email = (label: string) => `${label}-${randomUUID().slice(0, 8)}@hfos.test`;

async function bookOnline(
  owner: Owner,
  slug: string,
  startsAt: string,
  who: { name: string; phone?: string; email?: string },
  smsConsent: boolean,
): Promise<{ manageToken: string }> {
  const res = await fetch(`${WORKER}/public/book/${owner.site}/${slug}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: randomUUID(), startsAt, smsConsent, ...who }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { manageToken: string };
}

/** The one booking on a calendar at a time, as the staff sheet reads it (reminders included). */
async function attendeeAt(owner: Owner, calendarId: string, startsAt: string): Promise<Attendee> {
  const at = Date.parse(startsAt);
  const { items } = await api<{ items: { id: string }[] }>(
    owner.token,
    'queries',
    'appointment.list',
    {
      workspaceId: owner.workspaceId,
      from: new Date(at - 60_000).toISOString(),
      to: new Date(at + 60_000).toISOString(),
      calendarIds: [calendarId],
      status: ['scheduled', 'cancelled'],
    },
  );
  const { appointment } = await api<{ appointment: { attendees: Attendee[] } }>(
    owner.token,
    'queries',
    'appointment.get',
    { workspaceId: owner.workspaceId, appointmentId: items[0]!.id },
  );
  return appointment.attendees[0]!;
}

/** Both reminder jobs, run now as of when each was due. */
async function runReminders(owner: Owner, attendeeId: string): Promise<void> {
  const res = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: owner.workspaceId,
      dedupeKeys: [
        `appt-reminder:${attendeeId}:day_before`,
        `appt-reminder:${attendeeId}:before_120`,
      ],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    moved: unknown[];
    ran: { failed: number; retried: number };
  };
  expect(body.moved).toHaveLength(2);
  expect(body.ran.failed + body.ran.retried).toBe(0);
}

const statuses = (a: Attendee) =>
  ['day_before', 'before_120'].map((k) => [
    a.reminders.reminders[k]?.status,
    a.reminders.reminders[k]?.channel ?? null,
  ]);

test('the day-before and 2-hour reminders go out; STOP means email only; a cancelled booking gets none', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'reminders-owner', 'Lone Star Reminders HVAC');
  const number = await setUpTexting(page, owner.workspaceId);
  // Quiet hours off: nothing here depends on the time of day it runs at.
  await api(owner.token, 'commands', 'phone.update_settings', {
    workspaceId: owner.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  const cal = await makeCalendar(owner, 'AC tune-up');

  // Mike agreed to texts: a text confirmation, then both reminders by text.
  const mikeAt = daysAt(3);
  await bookOnline(owner, cal.slug, mikeAt, { name: 'Mike Johnson', phone: phone() }, true);
  await expect
    .poll(async () => (await attendeeAt(owner, cal.id, mikeAt)).reminders.confirmation?.channel, {
      timeout: 30_000,
    })
    .toBe('sms');
  const mike = await attendeeAt(owner, cal.id, mikeAt);
  expect(statuses(mike)).toEqual([
    ['scheduled', null],
    ['scheduled', null],
  ]);
  await runReminders(owner, mike.id);
  await expect
    .poll(async () => statuses(await attendeeAt(owner, cal.id, mikeAt)), { timeout: 30_000 })
    .toEqual([
      ['sent', 'sms'],
      ['sent', 'sms'],
    ]);
  const sent = (await attendeeAt(owner, cal.id, mikeAt)).reminders.reminders;
  const message = async (id: string) =>
    (
      await api<{ message: { body: string; status: string; channel: string } }>(
        owner.token,
        'queries',
        'message.get',
        { workspaceId: owner.workspaceId, messageId: id },
      )
    ).message;
  const dayBefore = await message(sent['day_before']!.messageId!);
  expect(dayBefore.channel).toBe('sms');
  expect(dayBefore.body).toContain(
    'Reminder from Lone Star Reminders HVAC: your AC tune-up is tomorrow,',
  );
  expect((await message(sent['before_120']!.messageId!)).body).toMatch(
    /^Lone Star Reminders HVAC: Your AC tune-up with .+ is today at \d{1,2}:\d{2} [AP]M\. Questions\? Call /,
  );
  // The fake carrier delivered them.
  await expect
    .poll(async () => (await message(sent['day_before']!.messageId!)).status, { timeout: 20_000 })
    .toBe('delivered');

  // Olga's number texted STOP: even with the box ticked, everything goes by email.
  const olgaPhone = phone();
  const olgaEmail = email('olga');
  await textFromCustomer({ from: olgaPhone, to: number, body: 'STOP' });
  await expect
    .poll(
      async () =>
        (
          await api<{ items: unknown[] }>(owner.token, 'queries', 'inbox.list', {
            workspaceId: owner.workspaceId,
            q: olgaPhone.slice(2),
          })
        ).items.length,
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const olgaAt = daysAt(4);
  await bookOnline(
    owner,
    cal.slug,
    olgaAt,
    { name: 'Olga Stop', phone: olgaPhone, email: olgaEmail },
    true,
  );
  await waitForMail(olgaEmail, 'You’re booked: AC tune-up');
  await expect
    .poll(async () => statuses(await attendeeAt(owner, cal.id, olgaAt)), { timeout: 30_000 })
    .toEqual([
      ['scheduled', null],
      ['scheduled', null],
    ]);
  await runReminders(owner, (await attendeeAt(owner, cal.id, olgaAt)).id);
  const dayMail = await waitForMail(olgaEmail, 'Reminder: AC tune-up tomorrow at');
  expect(dayMail.text).toContain('Sent by email because Olga asked us not to text.');
  await waitForMail(olgaEmail, 'Reminder: AC tune-up today at');
  const olga = await attendeeAt(owner, cal.id, olgaAt);
  expect(olga.reminders.confirmation?.channel).toBe('email');
  expect(statuses(olga)).toEqual([
    ['sent', 'email'],
    ['sent', 'email'],
  ]);

  // Carl cancels: his reminders are skipped and nothing more reaches him.
  const carlEmail = email('carl');
  const carlAt = daysAt(5);
  const carl = await bookOnline(
    owner,
    cal.slug,
    carlAt,
    { name: 'Carl Cancel', email: carlEmail },
    false,
  );
  await waitForMail(carlEmail, 'You’re booked: AC tune-up');
  await expect
    .poll(async () => statuses(await attendeeAt(owner, cal.id, carlAt)), { timeout: 30_000 })
    .toEqual([
      ['scheduled', null],
      ['scheduled', null],
    ]);
  const carlId = (await attendeeAt(owner, cal.id, carlAt)).id;
  const cancelled = await fetch(`${WORKER}/public/manage/${carl.manageToken}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(cancelled.status).toBe(200);
  await waitForMail(carlEmail, 'Cancelled: AC tune-up');
  await runReminders(owner, carlId);
  await expect
    .poll(async () => statuses(await attendeeAt(owner, cal.id, carlAt)), { timeout: 30_000 })
    .toEqual([
      ['skipped', null],
      ['skipped', null],
    ]);
  const subjects = (
    (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${carlEmail}"`)}`)
    ).json()) as { messages: { Subject: string }[] }
  ).messages.map((m) => m.Subject);
  expect(subjects.some((s) => s.startsWith('Reminder:'))).toBe(false);
});

/**
 * A freed time is offered at once in the daytime. In quiet hours (8 PM to 8 AM where the business is) the offer
 * waits until they end, so nobody's held time runs out while they sleep: then the waiting job runs now, as of
 * 8 AM. Either way the customer gets the email, whatever time of day the suite runs.
 */
async function offerEmail(owner: Owner, calendarId: string, startsAt: string, to: string) {
  const subject = 'A time opened: Leak check';
  const at = Date.parse(startsAt);
  const { items } = await api<{ items: { id: string }[] }>(
    owner.token,
    'queries',
    'appointment.list',
    {
      workspaceId: owner.workspaceId,
      from: new Date(at - 60_000).toISOString(),
      to: new Date(at + 60_000).toISOString(),
      calendarIds: [calendarId],
      status: ['scheduled', 'cancelled'],
    },
  );
  const waiting = `waitlist-offer-next:${items[0]!.id}`;
  await expect
    .poll(
      async () => {
        const run = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId: owner.workspaceId, dedupeKeys: [waiting] }),
        });
        const { moved } = (await run.json()) as { moved: unknown[] };
        if (moved.length > 0) return 'sent when quiet hours ended';
        const search = await fetch(
          `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
        );
        const { messages } = (await search.json()) as { messages: { Subject: string }[] };
        return messages.some((m) => m.Subject.includes(subject)) ? 'sent at once' : 'not yet';
      },
      { timeout: 30_000 },
    )
    .not.toBe('not yet');
  return waitForMail(to, subject);
}

test('a waitlist offer’s link shows the held time and books it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'offer-owner', 'Bayou Offer Plumbing');
  const cal = await makeCalendar(owner, 'Leak check', { waitlist: { enabled: true } });
  const at = daysAt(3);
  const first = await bookOnline(
    owner,
    cal.slug,
    at,
    { name: 'Hal Early', email: email('hal') },
    false,
  );
  const ivyEmail = email('ivy');
  const joined = await fetch(`${WORKER}/public/book/${owner.site}/${cal.slug}/waitlist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Ivy Waiting',
      email: ivyEmail,
      wantedFrom: new Date(Date.parse(at) - HOUR).toISOString(),
      wantedTo: new Date(Date.parse(at) + 2 * HOUR).toISOString(),
    }),
  });
  expect(joined.status).toBe(200);
  // Hal cancels: the time is offered to Ivy, by email with its link.
  const cancelled = await fetch(`${WORKER}/public/manage/${first.manageToken}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(cancelled.status).toBe(200);
  const offer = await offerEmail(owner, cal.id, at, ivyEmail);
  const link = /http:\/\/localhost:3000(\/w\/[0-9A-Za-z]{18})/.exec(offer.text)![1]!;

  const customer = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const c = await customer.newPage();
  await c.goto(link);
  await expect(c.getByTestId('offer-open')).toBeVisible();
  await expect(c.getByRole('heading', { name: 'Leak check' })).toBeVisible();
  await expect(c.getByTestId('offer-hold')).toContainText('We’re holding it for you until');
  await c.getByRole('button', { name: 'Book this time' }).click();
  await expect(c.getByTestId('offer-booked')).toBeVisible();
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  // Back again later: still booked, with the way to change or cancel it.
  await c.reload();
  await expect(c.getByTestId('offer-booked')).toBeVisible();
  await c.getByRole('link', { name: 'Change or cancel' }).click();
  await expect(c).toHaveURL(/\/m\/[0-9A-Za-z]{18}$/);
  await expect(c.getByTestId('manage-booked')).toBeVisible();
  await customer.close();
});
