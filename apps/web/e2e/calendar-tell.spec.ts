/**
 * Tell on a staff booking, end to end on the fake carrier. Unticked, the customer gets no confirmation (their
 * reminders are still set up); ticked, one text goes through the fake carrier. Then the worker's test route
 * runs the told booking's reminders as of when they were due, and the appointment sheet shows them sent.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  api,
  makeCalendar,
  ownerWithSite,
  randomPhone,
  WORKER,
  type Owner,
} from './booking-helpers';
import { chicagoDate } from './calendar';
import { setUpTexting } from './telephony';

const DAY = 86_400_000;
const NOTE_TOLD = 'Texts now, then reminders the day before at 4 PM and 2 hours before.';
const NOTE_UNTOLD =
  'No confirmation now. Reminders still go the day before at 4 PM and 2 hours before.';

interface Entry {
  status: string;
  channel: string | null;
  messageId: string | null;
}
interface Booking {
  appointmentId: string;
  attendeeId: string;
  confirmation: Entry | null;
  reminders: Record<string, Entry>;
}

/** The customer's one upcoming booking, as the staff sheet reads it (reminders included). */
async function bookingOf(owner: Owner, personId: string): Promise<Booking> {
  const { items } = await api<{ items: { id: string }[] }>(
    owner.token,
    'queries',
    'appointment.list',
    {
      workspaceId: owner.workspaceId,
      from: new Date().toISOString(),
      to: new Date(Date.now() + 14 * DAY).toISOString(),
      personId,
    },
  );
  expect(items).toHaveLength(1);
  const { appointment } = await api<{
    appointment: {
      attendees: {
        id: string;
        reminders: { confirmation: Entry | null; reminders: Record<string, Entry> };
      }[];
    };
  }>(owner.token, 'queries', 'appointment.get', {
    workspaceId: owner.workspaceId,
    appointmentId: items[0]!.id,
  });
  const a = appointment.attendees[0]!;
  return {
    appointmentId: items[0]!.id,
    attendeeId: a.id,
    confirmation: a.reminders.confirmation,
    reminders: a.reminders.reminders,
  };
}

const statuses = (b: Booking) =>
  ['day_before', 'before_120'].map((k) => [
    b.reminders[k]?.status,
    b.reminders[k]?.channel ?? null,
  ]);

/** From the customer's page: New appointment at 10 AM Chicago on `date`, Tell left ticked or unticked. */
async function bookFromTheirPage(
  page: Page,
  owner: Owner,
  personId: string,
  first: string,
  date: string,
  tell: boolean,
): Promise<void> {
  await page.goto(`/app/w/${owner.workspaceId}/customers/people/${personId}`);
  await page.getByTestId('action-book').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByLabel('Date').fill(date);
  await dialog.getByLabel('Start').selectOption('600');
  const box = dialog.getByTestId('appointment-tell');
  const note = dialog.getByTestId('appointment-tell-note');
  await expect(dialog).toContainText(`Tell ${first}`);
  await expect(box).toBeChecked();
  await expect(note).toHaveText(NOTE_TOLD);
  if (!tell) {
    await box.uncheck();
    await expect(note).toHaveText(NOTE_UNTOLD);
  }
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked .* at 10:00 AM\.$/)).toBeVisible();
}

test('Tell on a staff booking: unticked sends nothing, ticked texts once, and the sheet shows reminders sent', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'tell-owner', 'Gulf Coast Tell HVAC');
  await setUpTexting(page, owner.workspaceId);
  // Quiet hours off: nothing here depends on the time of day it runs at.
  await api(owner.token, 'commands', 'phone.update_settings', {
    workspaceId: owner.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  await makeCalendar(owner, 'Tune-up');
  const customer = async (first: string) =>
    (
      await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
        workspaceId: owner.workspaceId,
        firstName: first,
        lastName: 'Tellman',
        phone: randomPhone(),
      })
    ).personId;
  const ann = await customer('Ann');
  const ben = await customer('Ben');

  // Ann first, with Tell unticked; then Ben, told. Whole days on the calendar, not 24-hour steps, so the
  // 25-hour day clocks go back on can't give them the same date.
  const [y, m, d] = chicagoDate(Date.now()).split('-').map(Number);
  const day = (n: number) => new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
  await bookFromTheirPage(page, owner, ann, 'Ann', day(3), false);
  await bookFromTheirPage(page, owner, ben, 'Ben', day(4), true);

  // Ben's confirmation went by text, and the fake carrier delivered it.
  await expect
    .poll(async () => (await bookingOf(owner, ben)).confirmation?.status, { timeout: 30_000 })
    .toBe('sent');
  const told = await bookingOf(owner, ben);
  expect(told.confirmation?.channel).toBe('sms');
  const message = async (id: string) =>
    (
      await api<{ message: { body: string; status: string; channel: string } }>(
        owner.token,
        'queries',
        'message.get',
        { workspaceId: owner.workspaceId, messageId: id },
      )
    ).message;
  await expect
    .poll(async () => (await message(told.confirmation!.messageId!)).status, { timeout: 20_000 })
    .toBe('delivered');
  expect((await message(told.confirmation!.messageId!)).body).toMatch(
    /^Gulf Coast Tell HVAC: You.re booked for a tune-up on /,
  );

  // Ann's booking was handled before Ben's: her reminders are set, but no confirmation and no text.
  await expect
    .poll(async () => statuses(await bookingOf(owner, ann)), { timeout: 30_000 })
    .toEqual([
      ['scheduled', null],
      ['scheduled', null],
    ]);
  const untold = await bookingOf(owner, ann);
  expect(untold.confirmation).toBeNull();
  const conversations = await api<{ items: unknown[] }>(owner.token, 'queries', 'inbox.list', {
    workspaceId: owner.workspaceId,
    personId: ann,
  });
  expect(conversations.items).toHaveLength(0);

  // Ben's reminders, run now as of when each was due.
  const res = await fetch(`${WORKER}/test/scheduled-jobs/run-due`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workspaceId: owner.workspaceId,
      dedupeKeys: [
        `appt-reminder:${told.attendeeId}:day_before`,
        `appt-reminder:${told.attendeeId}:before_120`,
      ],
    }),
  });
  expect(res.status).toBe(200);
  const ran = (await res.json()) as { moved: unknown[]; ran: { failed: number; retried: number } };
  expect(ran.moved).toHaveLength(2);
  expect(ran.ran.failed + ran.ran.retried).toBe(0);
  await expect
    .poll(async () => statuses(await bookingOf(owner, ben)), { timeout: 30_000 })
    .toEqual([
      ['sent', 'sms'],
      ['sent', 'sms'],
    ]);

  // The sheet: Ben's confirmation and both reminders sent by text.
  const sheet = page.getByTestId('appointment-sheet');
  const row = (label: string) => sheet.getByTestId('sheet-reminder').filter({ hasText: label });
  await page.goto(`/app/w/${owner.workspaceId}/calendar?appt=${told.appointmentId}`);
  await expect(row('Confirmation')).toHaveAttribute('data-state', 'sent');
  await expect(row('Confirmation')).toContainText('by text');
  await expect(row('Day before')).toHaveAttribute('data-state', 'sent');
  await expect(row('Day before')).toContainText('Sent');
  await expect(row('2 hours before')).toContainText('Sent');

  // Ann's: no confirmation row, and her reminders still to come.
  await page.goto(`/app/w/${owner.workspaceId}/calendar?appt=${untold.appointmentId}`);
  await expect(row('Day before')).toContainText('Scheduled');
  await expect(row('2 hours before')).toHaveAttribute('data-state', 'scheduled');
  await expect(row('Confirmation')).toHaveCount(0);
});
