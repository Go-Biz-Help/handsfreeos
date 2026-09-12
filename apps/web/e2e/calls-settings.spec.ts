import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting } from './telephony';

const said = (page: Page, text: string) => page.getByText(text, { exact: true });

/**
 * Settings → Texting & calls, "When a customer calls" and "Voicemail": forwarding phones, ring time and
 * the greeting save as they change and are still there after a reload.
 */
test('calls settings: forwarding phones, ring time and voicemail persist', async ({ page }) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'calls-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await setUpTexting(page, workspaceId);

  await expect(
    page.getByRole('heading', { name: 'When a customer calls', exact: true }),
  ).toBeVisible();
  await expect(said(page, 'Anyone with HandsFreeOS open: Test')).toBeVisible();
  await expect(said(page, '0 of 3 phones')).toBeVisible();

  // Both fields are needed, and the number has to be a real one.
  const addPhone = page.getByRole('button', { name: 'Add a phone', exact: true });
  const name = page.getByLabel('Phone name', { exact: true });
  const number = page.getByLabel('Phone number', { exact: true });
  const add = page.getByRole('button', { name: 'Add', exact: true });
  await addPhone.click();
  await expect(addPhone).toBeDisabled();
  await add.click();
  await expect(said(page, 'Name this phone.')).toBeVisible();
  await name.fill('Dale’s cell');
  await number.fill('555');
  await add.click();
  await expect(said(page, 'Enter a valid phone number.')).toBeVisible();
  await number.fill('(713) 555-0161');
  await add.click();
  await expect(said(page, 'Dale’s cell rings on the next call')).toBeVisible();
  const dale = page.getByRole('group', { name: 'Dale’s cell', exact: true });
  const daleRings = dale.getByRole('switch', { name: 'Ring this phone', exact: true });
  await expect(dale).toContainText('(713) 555-0161');
  await expect(daleRings).toBeChecked();
  await expect(said(page, '1 of 3 phones')).toBeVisible();

  // A second phone, removed again without a confirm.
  await addPhone.click();
  await name.fill('Office line');
  await number.fill('713-555-0102');
  await add.click();
  await expect(said(page, 'Office line rings on the next call')).toBeVisible();
  await expect(said(page, '2 of 3 phones')).toBeVisible();
  await page.getByRole('button', { name: 'Remove Office line', exact: true }).click();
  await expect(said(page, 'Office line removed')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Office line', exact: true })).toHaveCount(0);
  await expect(said(page, '1 of 3 phones')).toBeVisible();

  // Dale's cell off, 25 seconds of ringing, voicemail off.
  await daleRings.click();
  await expect(said(page, 'Dale’s cell won’t ring')).toBeVisible();
  await expect(daleRings).not.toBeChecked();
  const ringFor = page.getByLabel('Ring for', { exact: true });
  await expect(ringFor).toHaveValue('20');
  await ringFor.selectOption('25');
  await expect(said(page, 'Rings for 25 seconds')).toBeVisible();
  const voicemail = page.getByRole('switch', { name: 'Voicemail', exact: true });
  const greeting = page.getByLabel('Greeting', { exact: true });
  await expect(voicemail).toBeChecked();
  await expect(greeting).toHaveValue(
    'You’ve reached Lone Star HVAC & Roofing. Leave your name, number and what you need, and we’ll call you back today.',
  );
  await voicemail.click();
  await expect(said(page, 'Voicemail off')).toBeVisible();
  await expect(greeting).toHaveCount(0);

  await page.reload();
  await expect(dale).toContainText('(713) 555-0161');
  await expect(daleRings).not.toBeChecked();
  await expect(said(page, '1 of 3 phones')).toBeVisible();
  await expect(ringFor).toHaveValue('25');
  await expect(voicemail).not.toBeChecked();
  await expect(greeting).toHaveCount(0);

  // Back on, with a greeting of their own.
  await daleRings.click();
  await expect(said(page, 'Dale’s cell rings now')).toBeVisible();
  await voicemail.click();
  await expect(said(page, 'Voicemail on')).toBeVisible();
  const mine =
    'Thanks for calling Lone Star. Leave a message and we’ll call you back within the hour.';
  await greeting.fill(mine);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(said(page, 'Greeting saved')).toBeVisible();

  await page.reload();
  await expect(daleRings).toBeChecked();
  await expect(ringFor).toHaveValue('25');
  await expect(voicemail).toBeChecked();
  await expect(greeting).toHaveValue(mine);
});
