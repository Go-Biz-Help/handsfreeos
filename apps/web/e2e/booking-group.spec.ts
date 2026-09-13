import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, daysFromNow, makeCalendar, ownerWithSite, randomPhone } from './booking-helpers';

type Session = {
  appointment: {
    seatsTaken: number;
    attendees: { fullName: string; seats: number }[];
    waitlist: { fullName: string; position: number }[];
  };
};

/** A class with seats: one customer takes both seats, the next joins the waitlist. */
test('sessions show seats left, and a full one takes waitlist joins', async ({ page, browser }) => {
  const owner = await ownerWithSite(page, 'booking-group', 'Class E2E HVAC');
  const cal = await makeCalendar(owner, 'Homeowner HVAC class', {
    schedule: { mode: 'sessions' },
    capacity: { seats: 2, maxPartySize: 2 },
    waitlist: { enabled: true },
  });
  const publish = (startsAt: string) =>
    api<{ appointmentId: string }>(owner.token, 'commands', 'session.publish', {
      workspaceId: owner.workspaceId,
      calendarId: cal.id,
      startsAt,
      userIds: [owner.userId],
      acknowledgeWarnings: true,
    });
  const first = await publish(daysFromNow(3));
  await publish(daysFromNow(5));

  // The first customer books both seats of the first session.
  const one = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const a = await one.newPage();
  await a.goto(cal.path);
  const rows = a.getByTestId('session');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('2 seats left');
  await a.getByRole('button', { name: 'More' }).click();
  await expect(a.getByTestId('party-size')).toHaveText('2');
  await rows.first().getByRole('button', { name: 'Book 2 seats' }).click();
  await a.getByLabel('Name', { exact: true }).fill('Ana Ruiz');
  await a.getByLabel('Mobile', { exact: true }).fill(randomPhone());
  await a.getByRole('button', { name: 'Book Homeowner HVAC class' }).click();
  await expect(a.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await expect(a.getByTestId('booked-what')).toContainText('2 seats');
  await one.close();

  // The next customer finds it full and joins the waitlist; the second session still has seats.
  const two = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const b = await two.newPage();
  await b.goto(cal.path);
  const full = b.getByTestId('session').first();
  await expect(full).toContainText('Full');
  await expect(b.getByTestId('session').nth(1)).toContainText('2 seats left');
  await full.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(b.getByRole('heading', { name: 'Join the waitlist' })).toBeVisible();
  await b.getByLabel('Name', { exact: true }).fill('Ben Okafor');
  await b.getByLabel('Email', { exact: true }).fill(`${randomUUID().slice(0, 8)}@hfos.test`);
  await b.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(b.getByTestId('waitlisted')).toContainText('number 1');
  await two.close();

  const session = await api<Session>(owner.token, 'queries', 'appointment.get', {
    workspaceId: owner.workspaceId,
    appointmentId: first.appointmentId,
  });
  expect(session.appointment.seatsTaken).toBe(2);
  expect(session.appointment.attendees).toEqual([
    expect.objectContaining({ fullName: 'Ana Ruiz', seats: 2 }),
  ]);
  expect(session.appointment.waitlist).toEqual([
    expect.objectContaining({ fullName: 'Ben Okafor', position: 1 }),
  ]);
});
