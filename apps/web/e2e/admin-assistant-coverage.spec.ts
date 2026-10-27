import { expect, test } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Assistant coverage in the Admin area (/admin/assistant): what Ask HandsFreeOS can't do yet, page by page in menu
 * order, and Copy gaps, which hands every one to Claude.
 */
test('Assistant coverage lists what the Assistant can’t do yet, and copies the gaps for Claude', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { email } = await signUpAndConfirm(page, 'coverage-staff');
  await createBusiness(page, { name: 'Coverage Co' });
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);

  await page.goto('/admin/tickets');
  await page.getByTestId('admin-nav-assistant').click();
  await expect(page).toHaveURL(/\/admin\/assistant$/);
  await expect(page.getByRole('heading', { name: 'Assistant coverage' })).toBeVisible();
  // The gaps change as they're closed, so only the sections are checked here; core's tests check what's in them.
  await expect(page.getByRole('heading', { name: 'What it can’t do yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Settings still to check' })).toBeVisible();

  await page.getByTestId('coverage-copy').click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Keeping the Assistant able to do everything');
});
