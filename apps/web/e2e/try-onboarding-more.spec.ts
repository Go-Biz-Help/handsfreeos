import { expect, test, type Page } from '@playwright/test';
import { WORKER } from './booking-helpers';
import {
  BUSINESS_ADDRESS,
  createBusiness,
  linkFrom,
  PASSWORD,
  signUpAndConfirm,
  waitForMail,
} from './helpers';

/**
 * Admin → Try onboarding's other onboardings (20261027027500): from an offer link, an add-on's setup, the Main offer
 * builder, an agency setting up a client, joining from a team invite, and the affiliate application. Each starts on
 * the page, as a support admin, in a practice business made for it (or none, for the affiliate one).
 */

async function asAdmin(page: Page, label: string): Promise<string> {
  const { email } = await signUpAndConfirm(page, label);
  await createBusiness(page, { name: `${label} Real Co` });
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.goto('/admin/try');
  await expect(page.getByRole('heading', { name: 'Try onboarding' })).toBeVisible();
  return email;
}

async function practiceSignUp(page: Page): Promise<void> {
  await page.getByLabel('Full name').fill('Pretend Customer');
  await page.getByLabel('Work email').fill('pretend@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByTestId('check-email').getByLabel('6-digit code').fill('123456');
}

test('from an offer link: the plan, code, affiliate and website business ride along', async ({
  page,
}) => {
  await asAdmin(page, 'try-link');
  await page.getByTestId('try-start-offer_link').click();
  await page.getByTestId('try-link-plan').selectOption('yearly');
  await page.getByTestId('try-link-code').fill('spring-trial');
  await page.getByTestId('try-link-ref').fill('jane');
  await page.getByTestId('try-link-business').fill('Linked Plumbing');
  await page.getByTestId('try-link-industry').selectOption('plumbing');
  await page.getByTestId('try-go-offer_link').click();

  await expect(page).toHaveURL(/\/try\/sign-up\?/);
  const note = page.getByTestId('practice-link-note');
  await expect(note).toContainText('$497 a year');
  await expect(note).toContainText('spring-trial');
  await expect(note).toContainText('jane’s affiliate link');
  await practiceSignUp(page);

  // The website's business starts the setup's first screen off, as the real sign-up's does.
  await expect(page).toHaveURL(/\/try\/business\?/);
  await expect(page.getByTestId('setup-business-name')).toHaveValue('Linked Plumbing');
  await page.getByTestId('setup-line1').fill(BUSINESS_ADDRESS.line1);
  await page.getByTestId('setup-city').fill(BUSINESS_ADDRESS.city);
  await page.getByTestId('setup-state').selectOption(BUSINESS_ADDRESS.state);
  await page.getByTestId('setup-postal-code').fill(BUSINESS_ADDRESS.postalCode);
  await page.getByTestId('onboarding-setup-next').click();
  // On to the plan page with the plan and the code, or the setup when no spot is on sale.
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('practice-banner')).toBeVisible();
});

test('an add-on’s setup: a ready business offers every add-on, the ones still being built too', async ({
  page,
}) => {
  await asAdmin(page, 'try-addon');
  await page.getByTestId('try-start-addon').click();
  await page.getByTestId('try-addon').selectOption('contractor');
  await page.getByTestId('try-go-addon').click();

  await expect(page).toHaveURL(/\/app\/w\/[0-9a-f-]{36}\/add-ons\?addon=contractor$/);
  await expect(page.getByTestId('practice-banner')).toBeVisible();
  const card = page.getByTestId('addons-available').getByTestId('addon-contractor');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('addon-testing')).toBeVisible();
});

test('the Main offer builder: Content Creator is turned on first, then the builder opens', async ({
  page,
}) => {
  await asAdmin(page, 'try-offer');
  await page.getByTestId('try-start-main_offer').click();
  await page.getByTestId('try-go-main_offer').click();
  await expect(page).toHaveURL(/\/app\/w\/[0-9a-f-]{36}\/main-offer\/build$/, { timeout: 90_000 });
  await expect(page.getByTestId('practice-banner')).toBeVisible();
});

test('an agency setting up a client: the client’s setup opens, for the agency to hand over', async ({
  page,
}) => {
  await asAdmin(page, 'try-agency');
  await page.getByTestId('try-start-agency').click();
  await page.getByTestId('try-agency-name').fill('Pretend Agency');
  await page.getByTestId('try-name-agency').fill('Pretend Client Plumbing');
  await page.getByTestId('try-go-agency').click();
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('practice-banner')).toContainText('Practice business');
});

test('joining from a team invite: the email comes to you, you join as a member, then end it', async ({
  page,
}) => {
  const email = await asAdmin(page, 'try-invite');
  const started = Date.now();
  await page.getByTestId('try-start-invite').click();
  await page.getByTestId('try-name-invite').fill('Pretend Team Plumbing');
  await page.getByTestId('try-role').selectOption('member');
  await page.getByTestId('try-go-invite').click();
  await expect(page.getByTestId('try-invited')).toContainText(email);
  // Listed, waiting for you to join, with nothing to open yet.
  const row = page.locator('[data-testid^="try-waiting-"]');
  await expect(row).toBeVisible();

  const mail = await waitForMail(email, 'invited you to Pretend Team Plumbing', { after: started });
  expect(mail.text).toContain('Practice business');
  const link = linkFrom(mail.text, /https?:\/\/[^\s"'<>]+\/invite\/inv_[A-Za-z0-9_-]+/);
  await page.goto(new URL(link).pathname);
  await page.getByTestId('accept-invite').click();
  await expect(page).toHaveURL(/\/app\/w\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('practice-banner')).toBeVisible();
  // Joining lands on Home with the tour, as it does for a real teammate.
  await expect(page.getByTestId('tour')).toHaveAttribute('data-stop', 'home');
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  // A member holds no role that deletes a business; the person practising it ends it all the same.
  await page.getByTestId('practice-end').click();
  await page.getByTestId('practice-end-yes').click();
  await expect(page).toHaveURL(/\/admin\/try\?ended=1$/);
  await expect(page.getByTestId('try-ended')).toBeVisible();
});

test('signing up as an affiliate: the practice sign-up, then the application, with nothing sent', async ({
  page,
}) => {
  await asAdmin(page, 'try-affiliate');
  await page.getByTestId('try-start-affiliate').click();
  await expect(page).toHaveURL(/\/try\/sign-up\?then=affiliate$/);
  await practiceSignUp(page);

  await expect(page).toHaveURL(/\/try\/affiliate$/);
  await expect(page.getByTestId('practice-affiliate-note')).toBeVisible();
  await page.getByLabel('Your name').fill('Pretend Partner');
  await page.getByTestId('affiliate-apply-code').fill('pretend-partner');
  await page.getByTestId('affiliate-apply-us').check();
  await page.getByTestId('affiliate-apply-terms').check();
  await page.getByTestId('affiliate-apply-send').click();
  await expect(page.getByTestId('affiliate-standing')).toBeVisible();
  await expect(page.getByTestId('practice-affiliate-again')).toBeVisible();
});
