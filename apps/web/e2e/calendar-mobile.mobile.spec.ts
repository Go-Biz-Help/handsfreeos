import { expect, test } from '@playwright/test';
import { chicagoDate, createCalendar, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * On a phone: the bottom bar reaches the calendar, and its agenda books, opens and cancels — through
 * Day, Week and Month, and the arrows that walk past the week it opens on.
 */
test('the phone bar has the calendar, and the agenda books, opens and cancels', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'cal-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });

  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);
  await expect(bar.getByRole('button', { name: 'More' })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Customers' })).toHaveCount(0);

  // A Personal calendar, set up from the phone.
  await createCalendar(page, workspaceId, { name: 'Service calls' });

  await bar.getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  const agenda = page.getByTestId('agenda');
  await expect(agenda).toBeVisible();
  await expect(agenda).toContainText('Central Time');
  await expect(page.getByTestId('time-grid')).toBeHidden();

  // Book with the button in the corner.
  const day = weekdayAhead(1);
  await page.getByTestId('calendar-fab').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Start').selectOption('600');
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Service calls with .* at 10:00 AM\.$/)).toBeVisible();
  await expect(page.getByTestId(`agenda-day-${day}`)).toHaveAttribute('aria-pressed', 'true');
  const row = page.locator('[data-testid^="agenda-appt-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('10:00 AM');
  await expect(row).toContainText('Service calls');

  // The phone has the views too, and the same booking reads on all three.
  await page.getByTestId('agenda-view-week').click();
  const week = page.getByTestId('agenda-week');
  await expect(week).toBeVisible();
  await expect(week.getByTestId(`agenda-week-day-${day}`)).toContainText('1 appointment');
  await expect(week.locator('[data-testid^="agenda-appt-"]')).toHaveCount(1);

  await page.getByTestId('agenda-view-month').click();
  const month = page.getByTestId('month-compact');
  await expect(month).toBeVisible();
  await expect(month.locator('[data-testid^="month-dot-"]')).toHaveCount(1);
  // A day in the month hands itself to the day list, the way "+n more" does on a wide screen.
  await page.getByTestId(`month-day-${day}`).click();
  await expect(page.getByTestId(`agenda-day-${day}`)).toHaveAttribute('aria-pressed', 'true');

  // The arrows walk a week at a time, and come back to the same one.
  const stripStart = async () =>
    (await page.locator('[data-testid^="agenda-day-"]').first().getAttribute('data-testid'))!.slice(
      'agenda-day-'.length,
    );
  // A week, never the month's cells: the strip is read below, so it has to be the thing being read.
  await expect(page.locator('[data-testid^="agenda-day-"]')).toHaveCount(7);
  const first = await stripStart();
  await page.getByTestId('agenda-next').click();
  await expect
    .poll(stripStart)
    .toBe(chicagoDate(Date.parse(`${first}T12:00:00Z`) + 7 * 86_400_000));
  await page.getByTestId('agenda-prev').click();
  await expect.poll(stripStart).toBe(first);

  // Open it from the bottom and cancel it.
  await row.click();
  const sheet = page.getByTestId('appointment-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('sheet-when')).toContainText('10:00–11:00 AM');
  await sheet.getByTestId('sheet-cancel').click();
  await page.getByTestId('cancel-confirm').click();
  await expect(page.getByText(/^Cancelled\./)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row).toHaveCount(0);
  await expect(agenda).toContainText('Nothing booked');

  // Customers moved into More.
  await bar.getByRole('button', { name: 'More' }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Customers' })
    .click();
  await expect(page).toHaveURL(/\/customers$/);
});
