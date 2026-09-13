import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, ownerWithSite, randomPhone, WORKER } from './booking-helpers';
import { CHICAGO, chicagoDate, weekdayAhead } from './calendar';

/**
 * "No staff needed": a red light therapy shop whose bookings depend only on its open hours and how many
 * beds are free. Four beds, so four people take the same time and a fifth can't; a start ten minutes
 * later still books while a bed is free. The owner sees them under the bed, side by side, and nobody's
 * own day or week has them.
 */

const BED = 'Red light bed';
const SERVICE = 'Red light session';

/** "Tuesday, September 15": how the time picker names a day. */
const longDate = (date: string) =>
  new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));

/** "11:10" on Chicago's clock. */
const chicagoClock = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: CHICAGO,
  }).format(new Date(iso));

/** The open start times on one Chicago date, as Chicago clock times mapped to their instants. */
async function openOn(
  site: string,
  slug: string,
  serviceId: string,
  date: string,
): Promise<Map<string, string>> {
  const q = new URLSearchParams({
    from: new Date().toISOString(),
    to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    serviceId,
  });
  const res = await fetch(`${WORKER}/public/book/${site}/${slug}/slots?${q}`);
  expect(res.ok).toBe(true);
  const { slots } = (await res.json()) as { slots: { startsAt: string }[] };
  return new Map(
    slots
      .filter((s) => chicagoDate(Date.parse(s.startsAt)) === date)
      .map((s) => [chicagoClock(s.startsAt), s.startsAt]),
  );
}

/** Another customer books straight through the worker. */
async function bookDirect(
  site: string,
  slug: string,
  serviceId: string,
  startsAt: string,
): Promise<number> {
  const res = await fetch(`${WORKER}/public/book/${site}/${slug}/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: randomUUID(),
      startsAt,
      serviceId,
      name: 'Walk-in Customer',
      phone: randomPhone(),
      email: `walkin-${randomUUID().slice(0, 8)}@hfos.test`,
    }),
  });
  return res.status;
}

/** Picks a day in the booking page's month view, moving a month on when it isn't showing yet. */
async function pickDay(c: Page, date: string) {
  await expect(c.getByTestId('slot').first()).toBeVisible();
  const day = c.getByRole('button', { name: longDate(date), exact: true });
  if (!(await day.isVisible())) await c.getByRole('button', { name: 'Later' }).click();
  await day.click();
  await expect(day).toHaveAttribute('aria-pressed', 'true');
}

async function chooseTime(c: Page, date: string, clock: string) {
  await pickDay(c, date);
  await c
    .getByTestId('slot')
    .filter({ hasText: new RegExp(`^${clock}$`) })
    .click();
  await c.getByRole('button', { name: `Continue with ${clock}` }).click();
  await expect(c.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await c.getByLabel('Name', { exact: true }).fill(`Guest ${randomUUID().slice(0, 4)}`);
  await c.getByLabel('Mobile', { exact: true }).fill(randomPhone());
  await c.getByLabel('Email', { exact: true }).fill(`${randomUUID().slice(0, 8)}@hfos.test`);
}

/** One customer books a time on the page, then starts over for the next one. */
async function bookOnPage(c: Page, date: string, clock: string) {
  await chooseTime(c, date, clock);
  await c.getByRole('button', { name: `Book ${SERVICE}` }).click();
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  // Nobody on staff: no "Who" on the booked screen.
  await expect(c.getByTestId('booked-when')).toBeVisible();
  await expect(c.getByTestId('booked-who')).toHaveCount(0);
  await c.getByRole('button', { name: 'Book something else' }).click();
}

test('no staff needed: four beds take four people at once, a fifth can’t, a staggered start still books', async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);

  // 1. A fresh business with four red light beds and a 20-minute session (the catalog through the API).
  const owner = await ownerWithSite(page, 'bed-owner', 'Glow E2E Red Light');
  const { workspaceId, token, site } = owner;
  const { resourceId } = await api<{ resourceId: string }>(token, 'commands', 'resource.create', {
    workspaceId,
    name: BED,
    kind: 'equipment',
    quantity: 4,
  });
  const { serviceId } = await api<{ serviceId: string }>(token, 'commands', 'service.create', {
    workspaceId,
    name: SERVICE,
    durations: [20],
  });

  // 2. The builder: the Resource preset on the bed, No staff needed, the session every 10 minutes, shop
  //    hours, public and on.
  await page.goto(`/app/w/${workspaceId}/settings/calendars/new`);
  await page.getByTestId('preset-resource').click();
  const step = page.getByTestId('preset-resource-step');
  await expect(step).toBeVisible();
  await step.getByLabel('Which resource?').selectOption({ label: BED });
  await expect(page.getByTestId('preset-labels')).toContainText('Resource');
  await page.getByLabel('Name', { exact: true }).fill('Red light');
  await page.getByTestId('calendar-create').click();
  await expect(page).toHaveURL(/\/settings\/calendars\/[0-9a-f-]{36}$/);

  await page.getByTestId('module-team').click();
  await page.getByTestId('assignment-none').click();
  await expect(page.getByTestId('assignment-none')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('team-none-note')).toBeVisible();
  await expect(page.getByTestId('team-members')).toHaveCount(0);
  await expect(page.getByTestId('builder-how')).toContainText(
    `No staff needed. A time is open while the calendar is open and a ${BED} is free.`,
  );
  await expect(page.getByTestId('builder-labels')).toContainText('Resource');

  await page.getByTestId('module-services').click();
  await page.getByTestId('services-one').click();
  await page
    .getByTestId('service-picks')
    .getByRole('checkbox', { name: new RegExp(SERVICE) })
    .check();
  await page.getByLabel('Start times every').selectOption('10');

  await page.getByTestId('module-availability').click();
  await page.getByRole('switch', { name: 'Calendar hours' }).click();
  await expect(page.getByTestId('calendar-hours-editor')).toBeVisible();

  const online = page.getByTestId('builder-public');
  if ((await online.getAttribute('aria-checked')) !== 'true') await online.click();
  await page.getByTestId('builder-save').click();
  await expect(page.getByText(/^Saved as revision 2\./)).toBeVisible();
  await page.getByTestId('calendar-turn-on').click();
  await expect(page.getByTestId('calendar-status')).toHaveText('Active');
  const link = (await page.getByTestId('booking-link').textContent())!;
  const path = link.slice(link.indexOf('/book/')).trim();
  const slug = path.split('/').pop()!;

  // 3. Signed out: four people take 10:00 on the same day. A fifth, who picked 10:00 while a bed was
  //    still free, is told no bed is free then and offered other times; afterwards 10:00 isn't offered.
  const day = weekdayAhead(2);
  const customers = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const c = await customers.newPage();
  await c.goto(path);
  await expect(c.getByTestId('business-name')).toHaveText(owner.business);
  for (let i = 0; i < 3; i++) await bookOnPage(c, day, '10:00 AM');

  const fifth = await customers.newPage();
  await fifth.goto(path);
  await chooseTime(fifth, day, '10:00 AM');
  await bookOnPage(c, day, '10:00 AM');
  await fifth.getByRole('button', { name: `Book ${SERVICE}` }).click();
  const gone = fifth.getByTestId('slot-taken');
  await expect(gone).toContainText(`No ${BED} is free then`);
  await expect(fifth.getByTestId('fresh-slot').first()).toBeVisible();
  await expect(fifth.getByTestId('fresh-slot').filter({ hasText: /^10:00 AM$/ })).toHaveCount(0);
  await fifth.goto(path);
  await pickDay(fifth, day);
  await expect(fifth.getByTestId('slot').filter({ hasText: /^10:20 AM$/ })).toHaveCount(1);
  await expect(fifth.getByTestId('slot').filter({ hasText: /^10:00 AM$/ })).toHaveCount(0);
  await expect(fifth.getByTestId('slot').filter({ hasText: /^10:10 AM$/ })).toHaveCount(0);

  // 4. Staggered: three take 11:00, then 11:10 still books on the fourth bed. After that all four are in
  //    use from 11:10 to 11:20, so 11:00 and 11:10 are gone while 11:20 stays open.
  const before = await openOn(site, slug, serviceId, day);
  for (let i = 0; i < 3; i++)
    expect(await bookDirect(site, slug, serviceId, before.get('11:00')!)).toBe(200);
  await bookOnPage(c, day, '11:10 AM');
  const after = await openOn(site, slug, serviceId, day);
  expect(after.has('11:00')).toBe(false);
  expect(after.has('11:10')).toBe(false);
  expect(after.has('11:20')).toBe(true);
  await customers.close();

  // 5. The owner's Resources view: all eight under the bed, four side by side at 10:00 and at 11:00.
  await page.goto(`/app/w/${workspaceId}/calendar?view=resources&date=${day}`);
  const bedColumn = page.getByTestId(`grid-col-${resourceId}`);
  await expect(bedColumn.locator('[data-testid^="appt-"]')).toHaveCount(8);
  for (const tops of [['600'], ['660', '670']]) {
    const blocks = bedColumn.locator(
      tops.map((t) => `[data-testid^="appt-"][data-top="${t}"]`).join(', '),
    );
    await expect(blocks).toHaveCount(4);
    const lefts = await blocks.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    expect(new Set(lefts).size).toBe(4);
  }

  // Their details: the bed, and nobody to show or change.
  await bedColumn.locator('[data-testid^="appt-"][data-top="600"]').first().click();
  const sheet = page.getByTestId('appointment-sheet');
  await expect(sheet.getByTestId('sheet-resource')).toContainText(BED);
  await expect(sheet.getByTestId('sheet-person')).toHaveCount(0);
  await expect(sheet.getByTestId('sheet-reassign')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/appt=/);

  // The team's day gives them a lane of their own, named for the bed; the owner's own column has none.
  await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await expect(page.getByTestId(`grid-head-staffless-${resourceId}`)).toContainText(BED);
  await expect(
    page.getByTestId(`grid-col-staffless-${resourceId}`).locator('[data-testid^="appt-"]'),
  ).toHaveCount(8);
  await expect(
    page.getByTestId(`grid-col-${owner.userId}`).locator('[data-testid^="appt-"]'),
  ).toHaveCount(0);

  // A person's week leaves them out.
  await page.goto(`/app/w/${workspaceId}/calendar?view=week&date=${day}`);
  await expect(page.getByTestId(`grid-col-${day}`)).toBeVisible();
  await expect(page.locator('[data-testid^="appt-"]')).toHaveCount(0);

  // Staff booking: no "With", the bed it uses, and a full bed is a hard stop with other times.
  await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await page.getByTestId('calendar-new').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await expect(dialog.getByTestId('appointment-uses')).toContainText(`1 ${BED}`);
  await expect(dialog.getByLabel('With')).toHaveCount(0);
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Start').selectOption('600');
  await dialog.getByTestId('appointment-book').click();
  await expect(dialog.getByTestId('appointment-full')).toContainText(`No ${BED} is free then`);
  await expect(dialog.getByTestId('appointment-book')).toHaveText('Book');
  await dialog.getByTestId('appointment-fresh-time').first().click();
  await expect(dialog.getByTestId('appointment-full')).toHaveCount(0);
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(new RegExp(`^Booked ${SERVICE} for .*\\.$`))).toBeVisible();
});
