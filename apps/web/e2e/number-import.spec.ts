import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Bringing a number that already lives in Twilio (20261010000900), through Settings → Texting & calls.
 *
 * The local worker runs the fake carrier, whose numbers being watched for "arrive" a few approvals after the
 * first look — as if HighLevel's support, or Twilio's, had sent them — so the whole wait plays out here.
 */
const middle = () => String(200 + Math.floor(Math.random() * 799));

test('a GoHighLevel number: checked, watched for, and live on arrival, with texting still its own step', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'import-ghl');
  const workspaceId = await createBusiness(page, { name: 'Magnolia Pest Control' });
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  await page.getByTestId('bring-your-number').click();
  await expect(page.getByTestId('bring-number-step')).toBeVisible();
  await page.getByTestId('bring-from-highlevel').click();

  const step = page.getByTestId('highlevel-import');
  // Said before anything else is asked.
  await expect(step.getByTestId('never-release')).toContainText('Do not release or delete it');
  const number = `(256) ${middle()}-4471`;
  await step.getByTestId('highlevel-number').fill(number);
  await step.getByTestId('highlevel-check').click();
  await expect(step.getByTestId('highlevel-host')).toContainText('hosted in Twilio');
  await step.getByTestId('highlevel-start').click();

  // The request to send HighLevel, naming this business's own HandsFreeOS Twilio account.
  const card = page.getByTestId('imports-card');
  const request = card.getByTestId('transfer-request');
  await expect(request).toBeVisible({ timeout: 30_000 });
  await expect(request.getByTestId('transfer-destination')).toHaveText(/^AC/);
  // What HighLevel's guide asks for: the parent account, the sub-account, the number, a cutover window.
  await expect(request.getByTestId('transfer-parent')).toHaveText(/^AC/);
  await request.getByTestId('transfer-cutover').fill('a weekday after 6 PM Central');
  const text = request.getByRole('textbox', { name: 'The transfer request' });
  await expect(text).toHaveValue(/do not release/i);
  await expect(text).toHaveValue(/Twilio Account SID: AC/);
  await expect(text).toHaveValue(/Destination sub-account SID: AC/);
  await expect(text).toHaveValue(/Preferred cutover window: a weekday after 6 PM Central/);
  const row = card.locator('[data-testid^="import-row-"]');
  await expect(row).toHaveAttribute('data-setup', 'waiting_for_transfer');
  await expect(row).toHaveAttribute('data-texting', 'needs_registration');
  await page.screenshot({
    path: 'test-results/number-import-highlevel-waiting.png',
    fullPage: true,
  });

  // It lands. The number is live; texting registration is still a separate step.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('imports-card').locator('[data-setup="live"]')).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 90_000 });
  const live = page.getByTestId('imports-card').locator('[data-setup="live"]');
  await expect(live).toHaveAttribute('data-texting', 'needs_registration');
  await expect(live).toContainText('HighLevel’s registration does not move with the number');
  await page.screenshot({ path: 'test-results/number-import-highlevel-live.png', fullPage: true });
});

test('a Twilio account: connected, listed with who uses each number, one brought here', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'import-twilio');
  const workspaceId = await createBusiness(page, { name: 'Cypress Roofing' });
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  await page.getByTestId('bring-your-number').click();
  await page.getByTestId('bring-from-twilio').click();

  const connect = page.getByTestId('twilio-connect');
  await connect.getByTestId('twilio-account-sid').fill(`ACdemo${middle()}account${middle()}`);
  await connect.getByTestId('twilio-auth-token').fill('demo-auth-token-0123456789');
  await connect.getByTestId('twilio-connect-submit').click();

  const numbers = page.getByTestId('twilio-numbers');
  await expect(numbers).toBeVisible({ timeout: 30_000 });
  // The fake's stand-in account has one number HighLevel is using today.
  await expect(numbers.getByText('Used by HighLevel')).toBeVisible();
  await page.screenshot({ path: 'test-results/number-import-twilio-listed.png', fullPage: true });

  const first = numbers.locator('[data-testid^="twilio-bring-"]').first();
  await first.click();
  const card = page.getByTestId('imports-card');
  await expect(card.getByTestId('transfer-request')).toBeVisible({ timeout: 30_000 });
  await expect(
    card.getByTestId('transfer-request').getByRole('textbox', { name: 'The transfer request' }),
  ).toHaveValue(/From Account SID: AC/);
  await page.screenshot({ path: 'test-results/number-import-twilio-waiting.png', fullPage: true });
});

test('phone & texting: turned on for its Account SID before any number, and off again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUpAndConfirm(page, 'phone-switch');
  const workspaceId = await createBusiness(page, { name: 'Palmetto Pools' });
  await page.goto(`/app/w/${workspaceId}/settings/texting`);

  const card = page.getByTestId('phone-account-card');
  await expect(card.getByTestId('phone-account-status')).toHaveText('Off');
  await card.getByTestId('phone-account-switch').click();
  // Made now, so the SID is there to give HighLevel or Twilio before there is any number.
  await expect(card.getByTestId('phone-account-sid')).toHaveText(/^AC/, { timeout: 30_000 });
  // HighLevel asks for the parent account beside it.
  await expect(card.getByTestId('phone-account-parent')).toHaveText(/^AC/);
  await expect(card.getByTestId('phone-account-status')).toHaveText('On');
  await page.screenshot({ path: 'test-results/phone-account-on.png', fullPage: true });

  // Off asks first, then closes it for good.
  await card.getByTestId('phone-account-switch').click();
  await expect(card.getByTestId('phone-account-confirm')).toContainText('for good');
  await card.getByTestId('phone-account-off').click();
  await expect(card.getByTestId('phone-account-status')).toHaveText('Off', { timeout: 30_000 });
  await expect(card.getByTestId('phone-account-sid')).toHaveCount(0);
});

test('a number moved straight into the business’s own account: found there, and set up with one press', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'own-numbers');
  const workspaceId = await createBusiness(page, { name: 'Bayou Septic' });
  await page.goto(`/app/w/${workspaceId}/settings/texting`);

  const card = page.getByTestId('phone-account-card');
  await card.getByTestId('phone-account-switch').click();
  await expect(card.getByTestId('phone-account-sid')).toHaveText(/^AC/, { timeout: 30_000 });

  // The local fake puts one number in the account the first time it is listed, still pointed at HighLevel, as if
  // HighLevel's support had moved it there without anybody starting a transfer here.
  await card.getByTestId('own-numbers-look').click();
  const row = card.locator('[data-testid^="own-number-+"]').first();
  await expect(row).toHaveAttribute('data-state', 'new', { timeout: 30_000 });
  await expect(row).toContainText('Used by HighLevel');
  await page.screenshot({ path: 'test-results/own-numbers-found.png', fullPage: true });

  await row.locator('[data-testid^="own-number-setup-"]').click();
  // Nothing to send and nothing to wait for: it is live within moments, with texting still its own step.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('imports-card').locator('[data-setup="live"]')).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('imports-card').getByTestId('transfer-request')).toHaveCount(0);

  // One of the business's numbers now, so looking again offers nothing.
  await page.getByTestId('phone-account-card').getByTestId('own-numbers-look').click();
  await expect(page.getByTestId('own-numbers-empty')).toHaveText(/already set up here/, {
    timeout: 30_000,
  });
  await page.screenshot({ path: 'test-results/own-numbers-set-up.png', fullPage: true });
});
