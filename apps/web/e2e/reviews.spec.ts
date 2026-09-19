import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Reviews (M16): what customers said in public.
 *
 * The thing worth proving in a browser is the sign-in, because it is the part with the most moving pieces:
 * a business connects Google, the worker's stand-in page stands in for Google's, and the reviews are here
 * when it lands back. The rest — stars against thumbs, who may answer — has its own tests on the database.
 */
test('connects Google through the sign-in and shows what people said', async ({ page }) => {
  await signUpAndConfirm(page, 'reviews');
  const workspaceId = await createBusiness(page, { name: 'Reviews HVAC' });
  await page.goto(`/app/w/${workspaceId}/reviews`);

  // Nothing is copied from anywhere, and the empty state says so.
  await expect(page.getByText('Nothing is copied')).toBeVisible();

  await page.getByRole('button', { name: 'Connect' }).first().click();
  // The worker's stand-in sign-in, in place of Google's.
  await expect(page.getByRole('heading', { name: /Sign in to Google/ })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();

  await expect(page).toHaveURL(/\/reviews\?reviews=connected/);
  await expect(page.getByText('Connected')).toBeVisible();
});
