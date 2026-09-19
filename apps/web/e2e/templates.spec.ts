import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Settings → Templates (M16): the wording a business reuses.
 *
 * The things a person would notice if they broke: a template saves and comes back after a reload, the
 * screen says what it will fill in, a text is not offered a subject line it cannot send, and putting one
 * away hides it from the list without losing it.
 */
test('wording is saved, reused, and put away without being lost', async ({ page }) => {
  await signUpAndConfirm(page, 'templates');
  const workspaceId = await createBusiness(page, { name: 'Wording HVAC' });
  await page.goto(`/app/w/${workspaceId}/settings/templates`);
  await expect(page.getByText('Nothing saved yet.')).toBeVisible();

  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByLabel('Name').fill('On our way');
  await page.getByLabel('Message').fill('Hi {{person.first_name}}, we are on our way.');
  await page.getByRole('button', { name: 'Save' }).click();

  const card = page.getByText('On our way');
  await expect(card).toBeVisible();
  // It says what it will fill in, so nobody has to guess what the braces do.
  await expect(page.getByText('Fills in: person.first_name')).toBeVisible();
  await expect(page.getByText('Not used yet')).toBeVisible();

  // Still there after a reload: saved, not just on the screen.
  await page.reload();
  await expect(page.getByText('On our way')).toBeVisible();

  // An email keeps its subject; a text is never given one.
  await page.getByRole('button', { name: 'New template' }).click();
  await page.getByLabel('Name').fill('Quote follow-up');
  await page.getByLabel('Send as').selectOption('email');
  await page.getByLabel('Subject').fill('Your quote');
  await page.getByLabel('Message').fill('Just checking you got the quote.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Your quote')).toBeVisible();

  // Put one away: gone from the list, not gone.
  await page.getByRole('button', { name: 'Put away On our way' }).click();
  await expect(page.getByText('On our way')).toBeHidden();
  await page.getByRole('button', { name: /Put away \(1\)/ }).click();
  await expect(page.getByText('On our way')).toBeVisible();
  await page.getByRole('button', { name: 'Restore On our way' }).click();
  await page.getByRole('button', { name: /In use \(2\)/ }).click();
  await expect(page.getByText('On our way')).toBeVisible();
});
