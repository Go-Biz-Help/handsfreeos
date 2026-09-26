import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Bringing a number that already lives in Twilio (20261011000100), through Settings → Texting & calls.
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
  await expect(request.getByRole('textbox')).toHaveValue(/do not release/i);
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
  await expect(card.getByTestId('transfer-request').getByRole('textbox')).toHaveValue(
    /From Account SID: AC/,
  );
  await page.screenshot({ path: 'test-results/number-import-twilio-waiting.png', fullPage: true });
});
