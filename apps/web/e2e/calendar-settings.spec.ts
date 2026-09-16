import { expect, test } from '@playwright/test';
import { chicagoDate } from './calendar';
import { createBusiness, signUpAndConfirm, uniqueEmail } from './helpers';
import { WORKER_URL } from './telephony';

/**
 * My calendar and the shared catalogs: weekly hours with a lunch break, time off, connecting Google
 * through the worker's stand-in sign-in, a busy time from that calendar showing as "Busy" on the
 * calendar, then a service and a resource.
 */
test('hours, time off, a Google busy block, services and resources', async ({ page }) => {
  await signUpAndConfirm(page, 'cal-settings');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  await page.goto(`/app/w/${workspaceId}/settings`);
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'My calendar' })
    .click();
  await expect(page).toHaveURL(/\/settings\/my-calendar$/);
  const mine = page.getByTestId('my-calendar');
  await expect(mine).toContainText('No hours saved yet, so weekdays 9 to 5 apply.');
  await expect(mine.getByTestId('zone-chip')).toHaveText('Central Time');

  // Monday 8 to 12 and 1 to 6 (a lunch break), and Saturday mornings.
  await page.getByLabel('Monday start', { exact: true }).selectOption('480');
  await page.getByLabel('Monday end', { exact: true }).selectOption('720');
  await page.getByRole('button', { name: 'Add Monday hours' }).click();
  await page.getByLabel('Monday start 2').selectOption('780');
  await page.getByLabel('Monday end 2').selectOption('1080');
  await page.getByRole('switch', { name: 'Saturday off' }).click();
  await page.getByLabel('Saturday end', { exact: true }).selectOption('780');
  await page.getByTestId('hours-save').click();
  await expect(page.getByText('Your hours are saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Monday end', { exact: true })).toHaveValue('720');
  await expect(page.getByLabel('Monday end 2')).toHaveValue('1080');
  await expect(page.getByLabel('Saturday start', { exact: true })).toHaveValue('540');
  await expect(mine).not.toContainText('No hours saved yet');

  // Time off, all day for three days, then taken away again.
  await page.getByTestId('time-off-add').click();
  const off = page.getByRole('dialog', { name: 'Add time off' });
  await off.getByLabel('From').fill(chicagoDate(Date.now() + 10 * 86_400_000));
  await off.getByLabel('To').fill(chicagoDate(Date.now() + 12 * 86_400_000));
  await off.getByLabel('Note (optional)').fill('Vacation');
  await off.getByTestId('time-off-save').click();
  await expect(page.getByText('Time off added. Nobody can book those times.')).toBeVisible();
  const row = page.getByTestId('time-off-row');
  await expect(row).toContainText('All day');
  await expect(row).toContainText('Vacation');
  await row.getByRole('button', { name: /Remove time off/ }).click();
  await expect(page.getByText('Time off removed.')).toBeVisible();
  await expect(page.getByTestId('time-off-row')).toHaveCount(0);

  // Connect Google through the stand-in sign-in.
  const connection = page.getByTestId('calendar-connection');
  await expect(connection).toHaveAttribute('data-status', 'none');
  const account = uniqueEmail('dale').replace(/@.*$/, '@gmail.fake');
  await page.getByTestId('connect-google-calendar').click();
  await page.getByLabel('Email address').fill(account);
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page).toHaveURL(/\/settings\/my-calendar$/);
  await expect(page.getByText(/^Connected\. Your busy times are checked/)).toBeVisible();
  await expect(connection).toHaveAttribute('data-status', 'active');
  await expect(connection).toContainText(account);
  await expect(connection).toContainText('Connected');

  // A dentist appointment in that calendar (tomorrow, 16:00 UTC is late morning in Chicago).
  const start = new Date(Date.now() + 86_400_000);
  start.setUTCHours(16, 0, 0, 0);
  const res = await fetch(`${WORKER_URL}/test/calendars/busy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account,
      start: start.toISOString(),
      end: new Date(start.getTime() + 3_600_000).toISOString(),
    }),
  });
  expect(res.ok).toBe(true);
  await page.getByTestId('calendar-sync-now').click();
  // Inside the toast: the card says the same words while it has never synced, and matching both is a tie.
  await expect(
    page.locator('[data-sonner-toast]').getByText('Checking busy times now.'),
  ).toBeVisible();

  // It shows on the team's day as a grey "Busy" block, never with what it is.
  const day = chicagoDate(start);
  await expect
    .poll(
      async () => {
        await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
        return page.getByTestId('busy-block').count();
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBeGreaterThan(0);
  await expect(page.getByTestId('busy-block').first()).toHaveText('Busy');
  await expect(page.getByTestId('busy-block').first()).toHaveAttribute(
    'title',
    'Busy in Google Calendar',
  );

  // A service with two lengths and a setup buffer.
  await page.goto(`/app/w/${workspaceId}/settings/calendars/services`);
  await page.getByTestId('service-new').click();
  const editor = page.getByTestId('service-editor');
  await editor.getByLabel('Name', { exact: true }).fill('AC tune-up');
  await editor.getByLabel('Add a length').selectOption('90');
  await editor.getByLabel('Setup before').selectOption('15');
  await editor.getByTestId('service-save').click();
  await expect(page.getByText('AC tune-up added.')).toBeVisible();
  const service = page.getByTestId('service-row-AC tune-up');
  await expect(service).toContainText('1 h, 1 h 30 min');
  await expect(service).toContainText('15 / 0 min');
  await expect(service).toContainText('Everyone');

  // A truck two jobs can't share, then a second one.
  await page
    .getByRole('navigation', { name: 'Calendar settings' })
    .getByRole('link', { name: 'Resources' })
    .click();
  await page.getByTestId('resource-new').click();
  const dialog = page.getByRole('dialog', { name: 'New resource' });
  await dialog.getByLabel('Name', { exact: true }).fill('Truck 2');
  await dialog.getByLabel('Kind').selectOption('vehicle');
  await dialog.getByTestId('resource-save').click();
  await expect(page.getByText('Truck 2 added.')).toBeVisible();
  const truck = page.getByTestId('resource-row-Truck 2');
  await expect(truck).toContainText('Vehicle · any time');
  const count = truck.getByRole('group', { name: 'How many Truck 2' });
  await expect(count).toContainText('1');
  await truck.getByRole('button', { name: 'More (How many Truck 2)' }).click();
  await expect(count).toContainText('2');

  // The audit log files it all under Calendar, in plain words.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await page.getByLabel('Filter by activity').selectOption('calendar');
  const log = page.getByTestId('audit-log');
  await expect(log).toContainText('set their own hours to');
  await expect(log).toContainText('added time off for');
  await expect(log).toContainText('added the service AC tune-up');
  await expect(log).toContainText('added the resource Truck 2');
  await expect(log).toContainText('connected the Google Calendar');
});
