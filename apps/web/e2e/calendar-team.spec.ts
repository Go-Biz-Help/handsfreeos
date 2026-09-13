import { expect, test } from '@playwright/test';
import { addTeammate, apptIdOf, createCalendar, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/** Two people on the team's day: a booking and a reassignment show up on the other screen without reloading. */
test('a teammate sees a booking live, and a reassignment moves it into their column', async ({
  browser,
  page,
}) => {
  const owner = await signUpAndConfirm(page, 'team-owner');
  const business = 'Lone Star HVAC & Roofing';
  const workspaceId = await createBusiness(page, { name: business });
  const mate = await addTeammate(page, browser, workspaceId, business, 'Priya Natarajan');
  await createCalendar(page, workspaceId, { name: 'Estimates', preset: 'round_robin' });
  const day = weekdayAhead(2);

  // Priya watches the team's day: a column each.
  await mate.page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  const heads = mate.page.locator('[data-testid^="grid-head-"]');
  await expect(heads).toHaveCount(2);
  const priyaHead = heads.filter({ hasText: 'Priya Natarajan' });
  const priyaId = (await priyaHead.getAttribute('data-testid'))!.replace('grid-head-', '');
  // Give the private channel a moment to join.
  await mate.page.waitForTimeout(1500);

  // The owner books 10 AM with themselves.
  await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await page.getByTestId('calendar-new').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Start').selectOption('600');
  await dialog.getByLabel('With').selectOption({ label: owner.name });
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Estimates with /)).toBeVisible();
  const block = page.locator('[data-testid^="appt-"]');
  await expect(block).toHaveCount(1);
  const apptId = await apptIdOf(block);
  const ownerId = (await block.getAttribute('data-col'))!;
  expect(ownerId).not.toBe(priyaId);

  // Priya's screen shows it in the owner's column.
  const seen = mate.page.getByTestId(`appt-${apptId}`);
  await expect(seen).toHaveAttribute('data-col', ownerId, { timeout: 5000 });

  // The owner gives it to Priya.
  await block.click();
  await page.getByTestId('sheet-reassign').click();
  const who = page.getByTestId('reassign-dialog');
  await who.getByRole('checkbox', { name: /Priya Natarajan/ }).check();
  await who.getByRole('checkbox', { name: new RegExp(owner.name) }).uncheck();
  await page.getByTestId('reassign-save').click();
  await expect(page.getByText('Now with Priya.')).toBeVisible();
  await expect(page.getByTestId('appointment-sheet').getByTestId('sheet-person')).toHaveText(
    /Priya Natarajan/,
  );
  await expect(page.getByTestId(`appt-${apptId}`)).toHaveAttribute('data-col', priyaId);

  // And Priya's screen moves it into her own column.
  await expect(seen).toHaveAttribute('data-col', priyaId, { timeout: 5000 });
  await mate.context.close();
});
