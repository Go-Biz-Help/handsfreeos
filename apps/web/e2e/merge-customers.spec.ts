import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Two records for the same customer, merged from the customer's page: the duplicate's note moves to the one kept,
 * the one kept takes the email it was missing, and the duplicate's old page says where everything went.
 */
test('merge a duplicate into the customer kept → timeline, details, the old page and the audit log', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'merge-owner');
  const workspaceId = await createBusiness(page, { name: 'Merge HVAC' });

  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Phone').fill('(713) 555-0142');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  const mikeUrl = page.url();

  // The same number again, saved anyway: the duplicate, with an email and a note of its own.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Michael');
  await page.getByLabel('Phone').fill('713 555 0142');
  await page.getByLabel('Email').fill('mike.j@example.com');
  await expect(page.getByTestId('duplicate-warning')).toContainText('Mike Johnson already exists');
  await page.getByTestId('save-anyway').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  const michaelUrl = page.url();
  await page.getByTestId('action-note').click();
  await page.getByLabel('Note').fill('Gate code 4471.');
  await page.getByTestId('activity-save').click();
  await expect(page.getByTestId('timeline-note')).toContainText('Gate code 4471');

  // From Mike's page: pick Michael, keep Mike.
  await page.goto(mikeUrl);
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-merge').click();
  await page.getByLabel('The other record').fill('Michael');
  await page.getByRole('option', { name: /Michael/ }).click();
  await expect(page.getByTestId('merge-keep')).toContainText('Mike Johnson');
  await expect(page.getByTestId('merge-dup')).toContainText('Michael');
  await expect(page.getByTestId('merge-summary')).toContainText(
    'Filled in on Mike Johnson from Michael: email.',
  );
  await page.getByTestId('merge-confirm').click();

  await expect(page.getByTestId('timeline-system-merged')).toContainText(
    'merged Michael into this person',
  );
  await expect(page.getByTestId('timeline-note')).toContainText('Gate code 4471');
  await expect(page.getByRole('button', { name: 'mike.j@example.com' })).toBeVisible();

  // The duplicate's old page says where everything went, and can't be brought back.
  await page.goto(michaelUrl);
  await expect(page.getByTestId('archived-notice')).toContainText('Merged into Mike Johnson');
  await page.getByTestId('record-menu').click();
  await expect(page.getByTestId('record-archive')).toHaveCount(0);
  await expect(page.getByTestId('record-merge')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('merged-into-link').click();
  await expect(page).toHaveURL(mikeUrl);

  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByText('merged Michael into Mike Johnson')).toBeVisible();
});
