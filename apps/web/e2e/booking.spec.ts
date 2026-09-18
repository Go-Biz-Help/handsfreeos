import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  api,
  bookThroughWorker,
  makeCalendar,
  openTimes,
  ownerWithSite,
  randomPhone,
} from './booking-helpers';

type Listed = {
  items: {
    id: string;
    startsAt: string;
    status: string;
    source: string;
    attendees: { fullName: string }[];
  }[];
};
type One = { appointment: { startsAt: string; status: string } };

async function fillDetails(c: Page, name: string) {
  await expect(c.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await c.getByLabel('Name', { exact: true }).fill(name);
  await c.getByLabel('Mobile', { exact: true }).fill(randomPhone());
  await c.getByLabel('Email', { exact: true }).fill(`${randomUUID().slice(0, 8)}@hfos.test`);
}

/** A signed-out customer books on the public page, then moves and cancels it from the short link. */
test('a signed-out customer books, reschedules and cancels', async ({ page, browser }) => {
  const owner = await ownerWithSite(page, 'booking-owner', 'Lone Star E2E HVAC');
  const cal = await makeCalendar(owner, 'AC tune-up');

  const customer = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const c = await customer.newPage();
  // The permanent link sends customers to the current address.
  await c.goto(`/book/c/${cal.id}`);
  await expect(c).toHaveURL(new RegExp(`${cal.path}$`));
  await expect(c.getByTestId('business-name')).toHaveText('Lone Star E2E HVAC');
  await expect(c.getByRole('heading', { name: 'AC tune-up' })).toBeVisible();

  const first = c.getByTestId('slot').first();
  await expect(first).toBeVisible();
  const picked = (await first.textContent())!.trim();
  await first.click();
  await c.getByRole('button', { name: `Continue with ${picked}` }).click();
  await fillDetails(c, 'Mike Johnson');
  // The texting box starts unticked.
  await expect(c.getByRole('checkbox', { name: /Text me about this appointment/ })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // The page runs Cloudflare's check first (locally and in CI, its always-pass test keys) and sends its token.
  const booking = c.waitForRequest(
    (r) => r.method() === 'POST' && /\/public\/book\/[^/]+\/[^/]+\/bookings$/.test(r.url()),
  );
  await c.getByRole('button', { name: 'Book AC tune-up' }).click();
  expect((await booking).postDataJSON()).toMatchObject({ turnstileToken: expect.any(String) });
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await expect(c.getByTestId('booked-when')).toContainText(picked.split(' ')[0]!);
  await expect(c.getByTestId('booked-who')).toContainText('Lone Star E2E HVAC');

  // The owner's calendar has it, from the booking page.
  const range = {
    workspaceId: owner.workspaceId,
    from: new Date(Date.now() - 3_600_000).toISOString(),
    to: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    calendarIds: [cal.id],
  };
  const listed = await api<Listed>(owner.token, 'queries', 'appointment.list', range);
  const made = listed.items.find((i) => i.source === 'booking_page')!;
  expect(made.attendees.map((a) => a.fullName)).toEqual(['Mike Johnson']);

  // Change or cancel: move it to another time.
  await c.getByRole('link', { name: 'Change or cancel' }).click();
  await expect(c).toHaveURL(/\/m\/[0-9A-Za-z]{18}$/);
  await expect(c.getByTestId('manage-booked')).toBeVisible();
  await expect(c.getByTestId('manage-rules')).toContainText('You can move or cancel until');
  await c.getByRole('button', { name: 'Reschedule' }).click();
  // Any time but the one already booked. Late in the day only one may be left, so this can't ask for the
  // second: at 11 PM the page offered a single slot and the test failed for the hour, not the code.
  const slots = c.getByTestId('slot');
  await expect(slots.first()).toBeVisible();
  const times = await slots.allTextContents();
  const free = times.findIndex((t) => t.trim() !== picked);
  expect(free, `no time to move to besides ${picked}`).toBeGreaterThan(-1);
  const other = slots.nth(free);
  await other.click();
  await c.getByRole('button', { name: /^Move to / }).click();
  await expect(c.getByRole('status')).toContainText('Moved to');
  const moved = await api<One>(owner.token, 'queries', 'appointment.get', {
    workspaceId: owner.workspaceId,
    appointmentId: made.id,
  });
  expect(moved.appointment.startsAt).not.toBe(made.startsAt);
  expect(moved.appointment.status).toBe('scheduled');

  // Then cancel it.
  await c.getByRole('button', { name: 'Cancel it' }).click();
  await c.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(c.getByTestId('manage-cancelled')).toBeVisible();
  const cancelled = await api<One>(owner.token, 'queries', 'appointment.get', {
    workspaceId: owner.workspaceId,
    appointmentId: made.id,
  });
  expect(cancelled.appointment.status).toBe('cancelled');

  // A paused calendar's page says booking is off.
  const paused = await makeCalendar(owner, 'Duct cleaning', {}, 'paused');
  await c.goto(paused.path);
  await expect(c.getByTestId('booking-off')).toContainText('Online booking is off');
  await customer.close();
});

test('when someone else takes the time first, the page offers fresh times', async ({
  page,
  browser,
}) => {
  const owner = await ownerWithSite(page, 'booking-race', 'Bayou E2E Plumbing');
  const cal = await makeCalendar(owner, 'Leak check');
  const [earliest] = await openTimes(owner.site, cal.slug);

  const customer = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const c = await customer.newPage();
  await c.goto(cal.path);
  const first = c.getByTestId('slot').first();
  await expect(first).toBeVisible();
  await first.click();
  await c.getByRole('button', { name: /^Continue with/ }).click();
  await fillDetails(c, 'Sara Lee');
  // Someone else books the same time a moment earlier.
  expect(await bookThroughWorker(owner.site, cal.slug, earliest!.startsAt)).toBe(200);
  await c.getByRole('button', { name: 'Book Leak check' }).click();
  await expect(c.getByTestId('slot-taken')).toContainText('was just taken');
  await c.getByTestId('fresh-slot').first().click();
  await c.getByRole('button', { name: 'Book Leak check' }).click();
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await customer.close();
});
