import { expect, test } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Find a workspace, for HandsFreeOS support people (the owner, 2026-11-14): typing finds every business on HandsFreeOS,
 * below their own, and one opens in the Admin area's quick look with its way in. The list itself stays their own, and
 * nobody else's business shows for anyone who isn't support.
 */
test('support people find every business from the workspace switcher, and nobody else does', async ({
  page,
  browser,
}) => {
  // Somebody else's business, made in a window of its own.
  const stamp = Date.now().toString(36);
  const theirs = `Faraway Plumbing ${stamp}`;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const other = await ctx.newPage();
  await signUpAndConfirm(other, 'every-biz-owner');
  await createBusiness(other, { name: theirs });
  await ctx.close();

  const { email } = await signUpAndConfirm(page, 'every-biz-staff');
  await createBusiness(page, { name: `Own Shop ${stamp}` });

  // Not support yet: typing finds only their own.
  await page.getByTestId('workspace-switcher').click();
  await page.getByLabel('Find a workspace').fill(theirs);
  await expect(page.getByText('No workspaces match.')).toBeVisible();
  await expect(page.getByTestId('switcher-every-business')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Made a support admin, the list is still only theirs until they type.
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.reload();
  await page.getByTestId('workspace-switcher').click();
  await expect(page.getByText(`Own Shop ${stamp}`).last()).toBeVisible();
  await expect(page.getByText(theirs)).toHaveCount(0);
  await expect(page.getByTestId('switcher-every-business')).toHaveCount(0);

  // Typing finds the other business under All businesses on HandsFreeOS.
  await page.getByLabel('Find a workspace').fill('Faraway Plumbing');
  const every = page.getByTestId('switcher-every-business');
  await expect(every.getByText('All businesses on HandsFreeOS')).toBeVisible();
  await every.getByRole('button', { name: new RegExp(theirs) }).click();

  // It opens in the quick look, with the way in and the full page.
  const look = page.getByTestId('business-quick-look');
  await expect(look.getByRole('heading', { name: theirs })).toBeVisible();
  await expect(look.getByTestId('view-as-open')).toBeVisible();
  await expect(look.getByRole('link', { name: /Full page/i })).toBeVisible();
});
