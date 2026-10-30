import { expect, test } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { BUSINESS_ADDRESS, createBusiness, signUpAndConfirm } from './helpers';

/**
 * Setup's number and calendar steps the way a new owner with an EIN meets them, and what used to trip them up
 * (onboarding question 55): the website and the address from setup's first screen are already in website chat and
 * in the carriers' form; "Set this up for me" gives the website chat with the agreement box (its code to paste in
 * the footer, and a page showing what it asks) and the privacy policy and terms we host their addresses at once, so
 * the review lets the registration go without a reload once the chat has opened on the website; paying the
 * carriers' fees on Stripe's page comes back to the setup, not Settings; and the booking page the chat's box named,
 * switched off, is turned on by making the booking calendar. Before all that, the sign-up page's Terms and Privacy
 * Policy open.
 */

/** The website given on setup's first screen, which takes only a public https address. Nothing is served there. */
const WEBSITE = 'setup-fixes-electric.example';
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
    website: WEBSITE,
  });

  // Website chat starts from that website.
  await page.goto(`/app/w/${workspaceId}/settings/website-chat`);
  await expect(page.getByTestId('chat-setup').getByTestId('chat-site')).toContainText(WEBSITE);
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
  // The website and the address are the ones already given.
  await expect(page.getByLabel('Your website')).toHaveValue(`https://${WEBSITE}/`);
  await expect(page.getByLabel('Street address')).toHaveValue(BUSINESS_ADDRESS.line1);
  await expect(page.getByLabel('City', { exact: true })).toHaveValue(BUSINESS_ADDRESS.city);
  await expect(page.getByLabel('State', { exact: true })).toHaveValue(BUSINESS_ADDRESS.state);
  await expect(page.getByLabel('ZIP code')).toHaveValue(BUSINESS_ADDRESS.postalCode);
  // The review opens the website, as a carrier's reviewer would: here, the stand-in is the one that answers.
  await page.getByLabel('Your website').fill(KNOWLEDGE_SITE);
  await next.click();
  await page.getByLabel('Phone', { exact: true }).fill('(713) 555-0162');
  await next.click();
  await page.getByTestId('a2p-sensitive-none').check();
  await next.click();
  await page.getByTestId('a2p-suggestion-0').click();
  await page.getByTestId('a2p-suggestion-1').click();
  await next.click();

  // How customers agree: ours. The chat for their website, with its code to paste in the footer and the page showing
  // what it asks for the reviewer; its box names the business's first public page.
  await page.getByTestId('optin-hosted').click();
  await page.getByRole('button', { name: 'Set this up for me' }).click();
  await expect(page.getByTestId('optin-chat-code')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('chat-snippet')).toContainText('/embed/v1/wk_');
  await expect(page.getByTestId('chat-install')).toContainText('Not seen yet');
  const chatPage = page.getByTestId('optin-chat-page');
  await expect(chatPage).toHaveText(/\/chat\/wk_[A-Za-z0-9]{20}$/);
  const key = (await chatPage.textContent())!.split('/chat/')[1]!;
  // The page a reviewer opens shows the box, unticked, with the privacy policy and terms.
  const shown = await page.context().newPage();
  await shown.goto(`/chat/${key}`);
  await expect(shown.getByTestId('chat-showcase-form-texts')).not.toBeChecked();
  await expect(shown.getByRole('link', { name: 'Privacy policy' })).toBeVisible();
  await shown.close();
  // The chat opening on the website, as it does once its code is pasted in the footer: the review looks for that.
  const opened = await page.request.post(`${WORKER}/public/chat/${key}/start`, {
    data: { origin: KNOWLEDGE_SITE, pagePath: '/' },
  });
  expect(opened.ok()).toBe(true);
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

  // The calendar step: the booking page is there, named by the chat's box, and off.
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
