import { expect, test } from '@playwright/test';
import { addPerson, apptIdOf, createCalendar, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

// A teammate travelling in Los Angeles works a Chicago business: every time on screen is Chicago's.
test.use({ timezoneId: 'America/Los_Angeles' });

test('books from a customer page in Chicago time, drags with a confirm, then completes, no-shows and cancels', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'cal-la');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await createCalendar(page, workspaceId, { name: 'Estimates' });
  const personId = await addPerson(page, workspaceId, 'Mike', 'Johnson', '713-555-0142');

  // Book from Mike's page at 7 PM Chicago: after the owner's hours (weekdays 9 to 5), so it warns first.
  const day = weekdayAhead(3);
  await page.getByTestId('action-book').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await expect(dialog.getByTestId('appointment-customer')).toContainText('Mike Johnson');
  await expect(dialog).toContainText('Times are Central Time.');
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Start').selectOption('1140');
  await dialog.getByTestId('appointment-book').click();
  await expect(dialog.getByTestId('appointment-warnings')).toBeVisible();
  await expect(dialog.getByTestId('appointment-book')).toHaveText('Book anyway');
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Estimates with .* at 7:00 PM\.$/)).toBeVisible();
  await expect(page.getByTestId('upcoming-appointments')).toContainText('7:00–8:00 PM');
  await expect(page.getByTestId('timeline')).toContainText('booked Estimates for');

  // The right place in the week: 7 PM on that day's column, whatever the browser's zone.
  await page.goto(`/app/w/${workspaceId}/calendar?view=week&date=${day}`);
  await expect(page.getByTestId('calendar-page')).toContainText('Central Time');
  const block = page.locator('[data-testid^="appt-"]');
  await expect(block).toHaveCount(1);
  await expect(block).toHaveAttribute('data-col', day);
  await expect(block).toHaveAttribute('data-top', String(19 * 60));
  await expect(block).toContainText('7:00–8:00 PM');
  const apptId = await apptIdOf(block);

  // Drag it an hour earlier: the confirm shows was and now, and still warns (after hours).
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + 10;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - 30, { steps: 4 });
  await page.mouse.move(x, y - 60, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('move-dialog')).toBeVisible();
  await expect(page.getByTestId('move-now')).toContainText('6:00–7:00 PM');
  await expect(page.getByTestId('move-tell')).toBeChecked();
  await page.getByTestId('move-confirm').click();
  await expect(page.getByTestId('move-warnings')).toBeVisible();
  await expect(page.getByTestId('move-confirm')).toHaveText('Move anyway');
  await page.getByTestId('move-confirm').click();
  await expect(page.getByText(/^Moved to .* at 6:00 PM\.$/)).toBeVisible();
  const moved = page.getByTestId(`appt-${apptId}`);
  await expect(moved).toHaveAttribute('data-top', String(18 * 60));

  // Complete, then change it to a no-show.
  await moved.click();
  const sheet = page.getByTestId('appointment-sheet');
  await expect(sheet).toContainText('Mike Johnson');
  await expect(sheet.getByTestId('sheet-when')).toContainText('6:00–7:00 PM');
  await expect(page).toHaveURL(new RegExp(`appt=${apptId}`));
  await sheet.getByTestId('sheet-complete').click();
  await expect(sheet.getByTestId('sheet-status')).toHaveText('Completed');
  await sheet.getByTestId('sheet-no-show').click();
  await expect(sheet.getByTestId('sheet-status')).toHaveText('No-show');
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/appt=/);

  // An empty slot at 10 AM opens New appointment with the time filled in; book Mike, then cancel it.
  const column = page.getByTestId(`grid-col-${day}`);
  await column.click({ position: { x: 24, y: 3 * 60 + 10 } });
  const next = page.getByRole('dialog', { name: 'New appointment' });
  await expect(next.getByLabel('Start')).toHaveValue('600');
  await next.getByLabel('Customer').fill('Mike');
  await page.getByRole('option', { name: /Mike Johnson/ }).click();
  await next.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Estimates with .* at 10:00 AM\.$/)).toBeVisible();
  const second = page.locator('[data-testid^="appt-"][data-top="600"]');
  await expect(second).toHaveCount(1);
  await second.click();
  await sheet.getByTestId('sheet-cancel').click();
  const cancel = page.getByTestId('cancel-dialog');
  await expect(cancel).toContainText('Text Mike that it’s cancelled');
  await expect(page.getByTestId('cancel-tell')).toBeChecked();
  await page.getByLabel('Reason (optional)').fill('Customer asked');
  await page.getByTestId('cancel-confirm').click();
  await expect(page.getByText('Cancelled. The customer is being told.')).toBeVisible();
  await expect(second).toHaveCount(0);

  // Mike's timeline has the whole story, in Chicago time.
  await page.goto(`/app/w/${workspaceId}/customers/people/${personId}`);
  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText(/booked Estimates for .* at 7:00 PM/);
  await expect(timeline).toContainText(/rescheduled Estimates from .* at 7:00 PM to .* at 6:00 PM/);
  await expect(timeline).toContainText('a no-show');
  await expect(timeline).toContainText(/cancelled Estimates on .* at 10:00 AM/);
});
