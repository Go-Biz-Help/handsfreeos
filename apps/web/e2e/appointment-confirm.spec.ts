/**
 * Confirming an appointment (M8, design/m8 Confirm). The manage page's Confirm button confirms, and opening its
 * link never does (email scanners open links); a C reply on the fake carrier confirms after the day-before reminder
 * asks; and staff mark a visit confirmed for a customer HandsFreeOS can't ask, with Undo. The calendar sheet, the
 * customer's timeline and the audit log say so.
 */
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  api,
  makeCalendar,
  ownerWithSite,
  TURNSTILE_TEST_TOKEN,
  WORKER,
  type Owner,
} from './booking-helpers';
import { setUpTexting, textFromCustomer } from './telephony';

const DAY = 86_400_000;

/** Today plus `days` at 15:00 UTC (a morning in Chicago). */
function daysAt(days: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
}

const mobile = () => `+1713555${String(Math.floor(Math.random() * 9000) + 1000)}`;
const email = (label: string) => `${label}-${randomUUID().slice(0, 8)}@hfos.test`;

/**
 * Open every hour of every day (a business is open weekdays 8 to 5 until it says otherwise), and quiet hours as
 * given: nothing here leans on the time of day the spec runs at.
 */
async function pinHours(owner: Owner, quiet: boolean) {
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: owner.workspaceId,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  await api(owner.token, 'commands', 'phone.update_settings', {
    workspaceId: owner.workspaceId,
    quietHours: { enabled: quiet, start: '20:00', end: '08:00' },
  });
}

/** A customer books straight through the worker, as the public page does. */
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
    body: JSON.stringify({
      clientId: randomUUID(),
      startsAt,
      smsConsent,
      ...who,
      turnstileToken: TURNSTILE_TEST_TOKEN,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { manageToken: string };
}

/** The one booking on a calendar at a time: its appointment, and the customer's seat. */
async function bookingAt(owner: Owner, calendarId: string, startsAt: string) {
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
    },
  );
  const { appointment } = await api<{
    appointment: {
      id: string;
      attendees: {
        id: string;
        personId: string;
        reminders: {
          confirmation: { channel: string | null } | null;
          reminders: Record<string, { status: string; messageId: string | null }>;
        };
      }[];
    };
  }>(owner.token, 'queries', 'appointment.get', {
    workspaceId: owner.workspaceId,
    appointmentId: items[0]!.id,
  });
  return { appointmentId: appointment.id, seat: appointment.attendees[0]! };
}

/** The texts the business sent this customer. */
async function textsTo(owner: Owner, personId: string): Promise<string[]> {
  const { items } = await api<{
    items: { kind: string; body: string | null; meta: { direction?: string } }[];
  }>(owner.token, 'queries', 'timeline.list', {
    workspaceId: owner.workspaceId,
    recordType: 'person',
    recordId: personId,
    limit: 50,
  });
  return items
    .filter((i) => i.kind === 'sms' && i.meta.direction === 'outbound')
    .map((i) => i.body ?? '');
}

/** The customer's timeline entries for a confirmation. */
async function confirmations(owner: Owner, personId: string) {
  const { items } = await api<{ items: { subtype: string | null; meta: { via?: string } }[] }>(
    owner.token,
    'queries',
    'timeline.list',
    { workspaceId: owner.workspaceId, recordType: 'person', recordId: personId, limit: 50 },
  );
  return items.filter((i) => i.subtype === 'appointment_confirmed');
}

/** The staff sheet for one appointment, opened from the calendar's link. */
async function openSheet(page: Page, owner: Owner, appointmentId: string) {
  await page.goto(`/app/w/${owner.workspaceId}/calendar?appt=${appointmentId}`);
  const sheet = page.getByTestId('appointment-sheet');
  await expect(sheet).toBeVisible();
  return sheet;
}

test('the manage page confirms with its button, never by opening the link, and the calendar shows it', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'confirm-link', 'Lone Star Confirm HVAC');
  await pinHours(owner, false);
  const cal = await makeCalendar(owner, 'AC tune-up');
  const startsAt = daysAt(2);
  const { manageToken } = await bookOnline(
    owner,
    cal.slug,
    startsAt,
    { name: 'Denise Walker', email: email('denise') },
    false,
  );
  const { appointmentId, seat } = await bookingAt(owner, cal.id, startsAt);

  // The email's Confirm button opens ?confirm=1: the button is pointed at, and nothing is confirmed.
  const customer = await browser.newContext();
  const phone = await customer.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`/m/${manageToken}?confirm=1`);
  const box = phone.getByTestId('manage-confirm-box');
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute('data-highlight', 'true');
  await expect(box).toContainText('Will this time work?');
  // The business's short name ("Lone Star Confirm HVAC" → "Lone Star Confirm").
  await expect(box).toContainText('Lone Star Confirm asked you to confirm.');
  await phone.reload();
  await expect(phone.getByTestId('manage-confirm-box')).toBeVisible();
  await expect(phone.getByTestId('manage-confirmed')).toHaveCount(0);
  expect(await confirmations(owner, seat.personId)).toHaveLength(0);

  // Pressing it confirms.
  await phone.getByTestId('manage-confirm').click();
  await expect(phone.getByRole('status').first()).toContainText('You’re confirmed. See you');
  await expect(phone.getByTestId('manage-confirmed')).toContainText('Confirmed ·');
  await expect(phone.getByTestId('manage-confirm-box')).toHaveCount(0);
  await expect.poll(async () => (await confirmations(owner, seat.personId)).length).toBe(1);
  expect((await confirmations(owner, seat.personId))[0]!.meta.via).toBe('link');
  // It stays confirmed when the link is opened again.
  await phone.goto(`/m/${manageToken}`);
  await expect(phone.getByTestId('manage-confirmed')).toBeVisible();
  await customer.close();

  // The calendar sheet and the customer's timeline.
  const sheet = await openSheet(page, owner, appointmentId);
  await expect(sheet.getByTestId('sheet-confirmed')).toHaveAttribute('data-via', 'link');
  await expect(sheet.getByTestId('sheet-confirmed')).toContainText(/Confirmed online/);
  await page.goto(`/app/w/${owner.workspaceId}/customers/people/${seat.personId}`);
  await expect(page.getByText('Denise Walker confirmed AC tune-up online')).toBeVisible();
});

test('a C reply to the day-before reminder confirms, and the calendar sheet says by text', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'confirm-c', 'Lone Star Reply HVAC');
  const number = await setUpTexting(page, owner.workspaceId);
  // Quiet hours off: the reminder goes whatever the hour the spec runs at. (The thank-you text isn't wired into
  // the running worker until step 4 lists its handler, so it isn't checked here.)
  await pinHours(owner, false);
  const cal = await makeCalendar(owner, 'AC tune-up');
  const startsAt = daysAt(2);
  const denise = mobile();
  await bookOnline(owner, cal.slug, startsAt, { name: 'Denise Walker', phone: denise }, true);
  const { appointmentId, seat } = await bookingAt(owner, cal.id, startsAt);

  // Wait until the worker has armed the day-before reminder: run-due only moves a job that is already waiting.
  await expect
    .poll(
      async () =>
        (await bookingAt(owner, cal.id, startsAt)).seat.reminders.reminders['day_before']?.status,
      { timeout: 30_000 },
    )
    .toBe('scheduled');

  // The day-before reminder goes now, as of when it was due, and asks for a C. The reminder's record and its job
  // land in different transactions, so ask again until the job itself is there to move.
  const runDayBefore = async () => {
    const res = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: owner.workspaceId,
        dedupeKeys: [`appt-reminder:${seat.id}:day_before`],
      }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { moved: unknown[] }).moved.length;
  };
  await expect.poll(runDayBefore, { timeout: 30_000 }).toBe(1);
  const reminderId = async () =>
    (await bookingAt(owner, cal.id, startsAt)).seat.reminders.reminders['day_before']?.messageId ??
    null;
  await expect.poll(reminderId, { timeout: 30_000 }).not.toBeNull();
  const { message } = await api<{ message: { body: string } }>(
    owner.token,
    'queries',
    'message.get',
    { workspaceId: owner.workspaceId, messageId: (await reminderId())! },
  );
  expect(message.body).toContain('Reply C to confirm.');

  // Denise replies C.
  await textFromCustomer({ from: denise, to: number, body: 'C' });
  await expect
    .poll(async () => (await confirmations(owner, seat.personId)).map((c) => c.meta.via), {
      timeout: 30_000,
    })
    .toEqual(['sms']);

  // A short thank-you goes back by text.
  await expect
    .poll(async () => (await textsTo(owner, seat.personId)).some((b) => /confirmed for/i.test(b)), {
      timeout: 30_000,
    })
    .toBe(true);

  const sheet = await openSheet(page, owner, appointmentId);
  await expect(sheet.getByTestId('sheet-confirmed')).toHaveAttribute('data-via', 'sms');
  await expect(sheet.getByTestId('sheet-confirmed')).toContainText(/Confirmed by text/);
  await expect(sheet.getByTestId('sheet-confirmed')).toContainText(
    'Denise replied to the reminder.',
  );
});

test('staff mark a visit confirmed for a customer HandsFreeOS can’t ask, and Undo takes it back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'confirm-staff', 'Lone Star Staff HVAC');
  await pinHours(owner, true);
  const cal = await makeCalendar(owner, 'AC tune-up');
  const startsAt = daysAt(2);
  // A number without texting consent, and no email: nothing can ask him.
  await bookOnline(owner, cal.slug, startsAt, { name: 'Kevin OBrien', phone: mobile() }, false);
  const { appointmentId, seat } = await bookingAt(owner, cal.id, startsAt);

  const sheet = await openSheet(page, owner, appointmentId);
  const unconfirmed = sheet.getByTestId('sheet-unconfirmed');
  await expect(unconfirmed).toHaveAttribute('data-reachable', 'false');
  await expect(unconfirmed).toContainText('Not confirmed');
  await expect(unconfirmed).toContainText('Kevin can’t get texts and has no email on file');
  await expect(unconfirmed.getByRole('button', { name: 'Call Kevin' })).toBeVisible();

  await sheet.getByTestId('sheet-mark-confirmed').click();
  await expect(page.getByText('Marked Kevin’s visit confirmed.')).toBeVisible();
  await expect(sheet.getByTestId('sheet-confirmed')).toContainText('Confirmed by you');
  await expect.poll(async () => (await confirmations(owner, seat.personId)).length).toBe(1);

  // Undo, from the toast.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Confirmation taken back.')).toBeVisible();
  await expect(sheet.getByTestId('sheet-unconfirmed')).toBeVisible();
  await expect(sheet.getByTestId('sheet-confirmed')).toHaveCount(0);

  // The audit log says both, in plain words.
  await page.goto(`/app/w/${owner.workspaceId}/audit`);
  const log = page.getByTestId('audit-log');
  await expect(log).toContainText('confirmed');
  await expect(log).toContainText('took back the confirmation on AC tune-up');
});
