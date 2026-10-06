import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Setup's number and calendar steps the way a new owner with an EIN meets them, and what used to trip them up
 * (onboarding question 55): the website from the quick questions is already in website chat and in the carriers'
 * form; "Set this up for me" gives the agreement box, privacy policy and terms we host their addresses at once,
 * so the review lets the registration go without a reload; paying the carriers' fees on Stripe's page comes back
 * to the setup, not Settings; and the booking page the agreement box's form named, switched off, is turned on by
 * making the booking calendar. Before all that, the sign-up page's Terms and Privacy Policy open.
 */

/** The stand-in website playwright.config.ts serves, which the worker may open (FETCH_TEST_ORIGINS). */
const KNOWLEDGE_SITE = 'http://127.0.0.1:4190';

test('setup: a local number on what we host, its fees paid, and the booking page turned on', async ({
  page,
}) => {
  test.setTimeout(240_000);

  await page.goto('/sign-up');
  await expect(page.getByTestId('sign-up-terms')).toHaveAttribute(
    'href',
    'https://handsfreeos.com/terms',
  );
  await expect(page.getByTestId('sign-up-privacy')).toHaveAttribute(
    'href',
    'https://handsfreeos.com/privacy',
  );

  await signUpAndConfirm(page, 'setup-fixes');
  const workspaceId = await createBusiness(page, {
    name: 'Setup Fixes Electric',
    answerQuestions: true,
  });
  await page.getByTestId('question-goal').getByRole('button', { name: 'Getting booked' }).click();
  await page.getByTestId('question-customers').getByRole('button', { name: 'Nowhere yet' }).click();
  await page.getByTestId('question-team').getByRole('button', { name: 'Just me' }).click();
  await page.getByLabel('What’s your website?').fill(KNOWLEDGE_SITE);
  await page.getByTestId('questions-continue').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/setup/number$`));

  // Website chat starts from that website.
  await page.goto(`/app/w/${workspaceId}/settings/website-chat`);
  await expect(page.getByTestId('chat-setup').getByTestId('chat-site')).toContainText(
    '127.0.0.1:4190',
  );
  await expect(page.getByTestId('chat-create')).toBeEnabled();

  // The number step: an EIN means a local number.
  await page.goto(`/onboarding/${workspaceId}/setup/number`);
  await page.getByTestId('setup-ein-yes').click();
  await page.getByLabel('Area code').fill('713');
  const picked = page.getByTestId('number-results').getByRole('radio', { checked: true });
  // As in telephony.ts: on a cold dev server the search can submit before its script runs, so search again.
  await expect(async () => {
    await page.getByTestId('show-numbers').click();
    await expect(picked).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 90_000 });
  await page.getByTestId('buy-number').click();
  await expect(page.getByTestId('business-step')).toBeVisible({ timeout: 90_000 });
  const next = page.getByTestId('a2p-next');

  await page.getByLabel('Your EIN').fill('12-3456789');
  await next.click();
  // The website is the one already given.
  await expect(page.getByLabel('Your website')).toHaveValue(KNOWLEDGE_SITE);
  await page.getByLabel('Street address').fill('4410 Westpark Dr');
  await page.getByLabel('City', { exact: true }).fill('Houston');
  await page.getByLabel('State', { exact: true }).fill('TX');
  await page.getByLabel('ZIP code').fill('77027');
  await next.click();
  await page.getByLabel('Phone', { exact: true }).fill('(713) 555-0162');
  await next.click();
  await page.getByTestId('a2p-sensitive-none').check();
  await next.click();
  await page.getByTestId('a2p-suggestion-0').click();
  await page.getByTestId('a2p-suggestion-1').click();
  await next.click();

  // How customers agree: ours. Its form gets an address straight away, which is the business's first public page.
  await page.getByTestId('optin-hosted').click();
  await page.getByRole('button', { name: 'Set this up for me' }).click();
  await expect(page.getByText('This is live.', { exact: false })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: /\/f\/[a-z0-9-]+\/[a-z0-9-]+$/ })).toBeVisible();
  await next.click();

  // The privacy policy and terms we write, at their addresses under the same name.
  await expect(page.getByTestId('policy-hosted')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('link', { name: /\/legal\/[a-z0-9-]+\/privacy$/ })).toBeVisible();
  await next.click();

  // The review opens all of it, as a reviewer would, and lets it go: no reload needed.
  await page.getByTestId('business-agree').check();
  const send = page.getByTestId('submit-registration');
  await expect(send).toBeEnabled({ timeout: 60_000 });
  await expect(send).toHaveText(/^Pay \$[0-9.,]+ and send$/);
  await send.click();

  // Off to the payment page, and back to the setup once it's paid.
  await expect(page).toHaveURL(/\/payments\/fake\/checkout\//, { timeout: 60_000 });
  await page.getByTestId('fake-checkout-pay').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/setup/number\\?fees=paid$`), {
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: 'Get your business number' })).toBeVisible();

  // The calendar step: the booking page is there, named by the form, and off.
  await page.goto(`/onboarding/${workspaceId}/setup/calendar`);
  await expect(page.getByTestId('booking-site-link')).toBeVisible();
  await expect(page.getByTestId('booking-site-enabled')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('service-new').click();
  await page.getByTestId('service-editor').getByLabel('Name', { exact: true }).fill('Panel check');
  await page.getByTestId('service-save').click();
  await expect(page.getByTestId('service-row-Panel check')).toBeVisible();

  // Making the booking calendar turns it on, and the step is done.
  await page.getByTestId('setup-calendar-make').click();
  await expect(page.getByTestId('setup-calendar-made')).toBeVisible();
  await expect(page.getByTestId('booking-site-enabled')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('setup-booking-off')).toHaveCount(0);
  await expect(page.getByTestId('setup-rail-calendar')).toHaveAttribute('data-state', 'done');
});
