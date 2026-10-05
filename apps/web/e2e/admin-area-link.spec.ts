import { expect, test } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The workspace switcher's Admin area link: HandsFreeOS's own support people open /admin from it, the way an
 * organization's owners and admins open its agency area. Nobody else sees it.
 */
test('the workspace switcher links HandsFreeOS support people to the admin area, and nobody else', async ({
  page,
}) => {
  const { email } = await signUpAndConfirm(page, 'admin-link');
  await createBusiness(page, { name: 'Admin Link Co' });

  // The business's owner has its agency area, and no admin area.
  await page.getByTestId('workspace-switcher').click();
  await expect(page.getByRole('link', { name: 'Agency area' })).toBeVisible();
  await expect(page.getByTestId('admin-area-link')).toHaveCount(0);

  // Made a support admin, they have it too, and it opens the support desk.
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.reload();
  await page.getByTestId('workspace-switcher').click();
  await expect(page.getByText('HandsFreeOS · Support admin')).toBeVisible();
  await page.getByTestId('admin-area-link').click();
  await expect(page).toHaveURL(/\/admin\/tickets$/);
});
