import { expect, test } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { BUSINESS_ADDRESS, createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

/**
 * Admin → Try onboarding (20261027027400): a support admin goes through the new-business sign-up as a brand-new
 * customer would. The sign-up makes no login and sends nothing, the first screen makes a practice business owned by
 * them, its setup says it's practice on every screen, and End practice deletes it. Nobody else can find the page.
 */
test('a support admin practises the new-business sign-up in a practice business, then ends it', async ({
  page,
}) => {
  const { email } = await signUpAndConfirm(page, 'try-onboarding');
  await createBusiness(page, { name: 'Try Real Co' });

  // Not staff: no link, and the pages aren't there.
  await page.goto('/admin/try');
  await expect(page.getByRole('heading', { name: 'We could not find that' })).toBeVisible();

  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.goto('/admin/tickets');
  await page.getByTestId('admin-nav-try').click();
  await expect(page).toHaveURL(/\/admin\/try$/);
  await expect(page.getByRole('heading', { name: 'Try onboarding' })).toBeVisible();
  await expect(page.getByTestId('try-flow-offer_link')).toContainText('Coming next');
  await page.getByTestId('try-start-new_business').click();

  // The sign-up a new customer sees, saying it's practice. Anything goes, and any 6 digits.
  await expect(page).toHaveURL(/\/try\/sign-up$/);
  await expect(page.getByTestId('practice-sign-up-note')).toBeVisible();
  await page.getByLabel('Full name').fill('Pretend Customer');
  await page.getByLabel('Work email').fill('pretend@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('check-email').getByLabel('6-digit code').fill('123456');

  // The setup's first screen, which makes the practice business.
  await expect(page).toHaveURL(/\/try\/business$/);
  await expect(page.getByTestId('practice-business-note')).toBeVisible();
  await expect(page.getByTestId('setup-agency')).toHaveCount(0);
  await page.getByTestId('setup-business-name').fill('Practice Plumbing');
  await page.getByTestId('setup-kind-button-home').click();
  await page.getByTestId('setup-kind-home_services').click();
  await page.getByTestId('setup-line1').fill(BUSINESS_ADDRESS.line1);
  await page.getByTestId('setup-city').fill(BUSINESS_ADDRESS.city);
  await page.getByTestId('setup-state').selectOption(BUSINESS_ADDRESS.state);
  await page.getByTestId('setup-postal-code').fill(BUSINESS_ADDRESS.postalCode);
  await page.getByTestId('onboarding-setup-next').click();

  // From here it's the real setup, with the banner across it.
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}\?at=goal$/);
  await expect(page.getByTestId('onboarding-setup')).toHaveAttribute('data-screen', 'goal');
  await expect(page.getByTestId('practice-banner')).toContainText('Practice business');

  // On the admin's list, until it's ended from its own banner.
  await page.goto('/admin/try');
  await expect(page.getByText('Practice Plumbing')).toBeVisible();
  await page.getByRole('link', { name: 'Open' }).click();
  await expect(page.getByTestId('practice-banner')).toBeVisible();
  await page.getByTestId('practice-end').click();
  await page.getByTestId('practice-end-yes').click();
  await expect(page).toHaveURL(/\/admin\/try\?ended=1$/);
  await expect(page.getByTestId('try-ended')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open' })).toHaveCount(0);
});
