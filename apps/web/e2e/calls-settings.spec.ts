import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { getNumber, nextTo } from './telephony';

/**
 * Settings → Texting & calls once the business has its number: one card that says what the number does, with Change
 * on every row. Each Change opens the guided setup's own question, saves that part alone, and is still there after a
 * reload.
 */
test('calls settings: what rings, what callers get and call recording change from the number’s card', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'calls-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await getNumber(page, workspaceId);
  await page.goto(`/app/w/${workspaceId}/settings/texting`);

  const card = page.getByTestId('phone-card');
  const ring = card.getByTestId('row-ring');
  const missed = card.getByTestId('row-missed');
  const save = page.getByTestId('change-save');
  await expect(card.getByText('Calls working')).toBeVisible();
  await expect(ring).toContainText('HandsFreeOS');
  await expect(missed).toContainText('Voicemail after 20 seconds');

  // What rings: both boxes are needed, and the number has to be a real one.
  await expect(async () => {
    await card.getByTestId('change-ring').click();
    await expect(page.getByTestId('ring-editor')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await page.getByTestId('phone-more').check();
  await save.click();
  await expect(page.getByText('Say whose phone this is, like “Dale’s cell”.')).toBeVisible();
  await page.getByTestId('phone-label-0').fill('Dale’s cell');
  await page.getByTestId('phone-number-0').fill('555');
  await save.click();
  await expect(
    page.getByText('That doesn’t look like a phone number.', { exact: false }),
  ).toBeVisible();
  await page.getByTestId('phone-number-0').fill('(713) 555-0161');
  // A second phone, removed again before saving.
  await page.getByTestId('phone-add').click();
  await page.getByTestId('phone-label-1').fill('Office line');
  await page.getByTestId('phone-number-1').fill('713-555-0102');
  await page.getByTestId('phone-remove-1').click();
  await expect(page.getByTestId('phone-label-1')).toHaveCount(0);
  await page.getByTestId('caller-id-business').click();
  await save.click();
  await expect(page.getByTestId('ring-editor')).toHaveCount(0);
  await expect(ring).toContainText('HandsFreeOS and Dale’s cell');
  await expect(ring).toContainText('Dale’s cell is (713) 555-0161. It shows your business number.');

  // Cancel changes nothing.
  await card.getByTestId('change-missed').click();
  await page.getByTestId('ring-seconds-25').click();
  await page.getByTestId('change-cancel').click();
  await expect(missed).toContainText('Voicemail after 20 seconds');

  // If nobody picks up: 25 seconds of ringing, then a greeting of their own.
  const mine =
    'Thanks for calling Lone Star. Leave a message and we’ll call you back within the hour.';
  await card.getByTestId('change-missed').click();
  await expect(page.getByTestId('missed-voicemail')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('voicemail-greeting')).toHaveAttribute(
    'placeholder',
    'You’ve reached Lone Star HVAC & Roofing. Leave your name, number and what you need, and we’ll call you back today.',
  );
  await page.getByTestId('ring-seconds-25').click();
  await page.getByTestId('voicemail-greeting').fill(mine);
  await save.click();
  await expect(missed).toContainText('Voicemail after 25 seconds');

  // Call recording: turning the notice off says what to check first.
  const recording = card.getByTestId('row-recording');
  await expect(recording).toContainText('Callers hear “This call may be recorded.”');
  await card.getByTestId('change-recording').click();
  await page.getByTestId('recording-switch').click();
  await expect(
    page.getByText('Check with a lawyer before turning this off.', { exact: false }),
  ).toBeVisible();
  await save.click();
  await expect(recording).toContainText('Callers aren’t told calls are recorded');

  await page.reload();
  await expect(ring).toContainText('HandsFreeOS and Dale’s cell');
  await expect(missed).toContainText('Voicemail after 25 seconds');
  await expect(recording).toContainText('Callers aren’t told calls are recorded');

  // Dale's day off: his phone is switched off, not removed, and the greeting saved is the one shown.
  await expect(async () => {
    await card.getByTestId('change-ring').click();
    await expect(page.getByTestId('ring-editor')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('phone-label-0')).toHaveValue('Dale’s cell');
  await expect(page.getByTestId('caller-id-business')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('phone-rings-0').click();
  await save.click();
  await expect(ring).toContainText('One other phone is switched off.');
  await card.getByTestId('change-missed').click();
  await expect(page.getByTestId('voicemail-greeting')).toHaveValue(mine);
  // Nothing: callers hear that nobody can take the call.
  await page.getByTestId('missed-nothing').click();
  await save.click();
  await expect(missed).toContainText('Nothing after 25 seconds');

  // The same questions, one after another, from the link under the card, with today's answers filled in. Nothing
  // has gone to the carriers yet, so whether to text is still a question; the number itself isn't.
  await card.getByTestId('run-setup-again').click();
  const setup = page.getByTestId('phone-setup');
  await expect(setup).toHaveAttribute('data-screen', 'texting', { timeout: 60_000 });
  await expect(page.getByTestId('texting-yes')).toHaveAttribute('aria-checked', 'true');
  await nextTo(page, 'ring');
  await expect(page.getByTestId('phone-label-0')).toHaveValue('Dale’s cell');
  await expect(page.getByTestId('phone-more')).toBeChecked();
  await nextTo(page, 'missed');
  await expect(page.getByTestId('missed-nothing')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ring-seconds-25')).toHaveAttribute('aria-checked', 'true');
});
