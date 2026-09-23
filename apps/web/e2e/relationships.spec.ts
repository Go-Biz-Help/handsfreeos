import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Relationships (0101): a groomer sets up pets from a starter, adds a pet from a customer's page, gives the pet a
 * second owner from its own page, and both sides list each other. The pet has its own fields and notes, a tab
 * under Customers, and spouses stay one each.
 */
test('pets from a starter → added from a customer → a second owner → both sides → fields, notes, one spouse', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'relationships-owner');
  const workspaceId = await createBusiness(page, { name: 'Pawsome Grooming' });

  // Settings → Relationships: pets (with their fields and owners) in one press, then spouses.
  await page.goto(`/app/w/${workspaceId}/settings/relationships`);
  await page.getByTestId('kind-new').click();
  await page.getByTestId('kind-starter-pets').click();
  await expect(page.getByTestId('kind-pet')).toContainText('Pets');
  await expect(page.getByTestId('kind-pet')).toContainText('4 fields');
  await expect(page.getByTestId('types-list')).toContainText('Owner ↔ Pet');
  await expect(page.getByTestId('types-list')).toContainText('Each pet can have many owners.');
  await page.getByTestId('type-new').click();
  await page.getByTestId('type-starter-spouse').click();
  await expect(page.getByTestId('types-list')).toContainText('Each customer can have one spouse.');

  // A customer, and a pet made from her page.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Maria');
  await page.getByLabel('Last name').fill('Lopez');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  const mariaUrl = page.url();
  const card = page.getByTestId('relationships-card');
  await card.getByTestId('relationship-add').click();
  await page.getByTestId('relationship-option-Pet').click();
  await page.getByTestId('relationship-search').fill('Max');
  await page.getByTestId('relationship-create').click();
  await expect(card.getByRole('link', { name: 'Max' })).toBeVisible();
  await expect(page.getByTestId('timeline-system-related')).toContainText(
    'added a relationship: Maria Lopez (Owner) and Max (Pet)',
  );

  // The pet's own page lists its owner; a second owner is added from there (the only thing a pet can have).
  await card.getByRole('link', { name: 'Max' }).click();
  await expect(page).toHaveURL(/\/customers\/records\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('record-name')).toHaveText('Max');
  const petCard = page.getByTestId('relationships-card');
  await expect(petCard.getByRole('link', { name: 'Maria Lopez' })).toBeVisible();
  await petCard.getByTestId('relationship-add').click();
  await page.getByTestId('relationship-search').fill('Carlos Lopez');
  await page.getByTestId('relationship-create').click();
  await expect(petCard.getByRole('link', { name: 'Carlos Lopez' })).toBeVisible();
  await expect(petCard).toContainText('Owners · 2');

  // Its own fields and notes.
  await page.getByTestId('tab-details').click();
  await page.getByTestId('custom-fields-edit').click();
  await page.getByTestId('custom-fields-form').getByLabel('Breed').fill('Golden retriever');
  await page.getByTestId('custom-fields-save').click();
  await expect(page.getByTestId('custom-field-breed')).toHaveText('Golden retriever');
  await page.getByTestId('tab-timeline').click();
  await page.getByTestId('action-note').click();
  await page.getByLabel('Note').fill('Nervous with clippers.');
  await page.getByTestId('activity-save').click();
  await expect(page.getByTestId('timeline-note')).toContainText('Nervous with clippers.');

  // Pets have their own tab under Customers.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-tab-pet').click();
  await expect(page.getByTestId('records-table')).toContainText('Max');
  await expect(page.getByTestId('records-table')).toContainText('Golden retriever');

  // Spouses are one each: once Maria has one, adding another is greyed out.
  await page.goto(mariaUrl);
  await card.getByTestId('relationship-add').click();
  await page.getByTestId('relationship-option-Spouse').click();
  await page.getByTestId('relationship-search').fill('Carlos');
  await page.getByTestId('relationship-results').getByText('Carlos Lopez').click();
  await expect(card).toContainText('Spouse');
  await card.getByTestId('relationship-add').click();
  await expect(page.getByTestId('relationship-option-Spouse')).toBeDisabled();
  await expect(page.getByTestId('relationship-option-Spouse')).toContainText('already has one');
  await page.keyboard.press('Escape');

  // Carlos's page reads the same pairs from his side.
  await card.getByRole('link', { name: 'Carlos Lopez' }).click();
  await expect(page.getByTestId('record-name')).toHaveText('Carlos Lopez');
  await expect(
    page.getByTestId('relationships-card').getByRole('link', { name: 'Max' }),
  ).toBeVisible();
  await expect(
    page.getByTestId('relationships-card').getByRole('link', { name: 'Maria Lopez' }),
  ).toBeVisible();

  // Settings → Fields: another field for pets.
  await page.goto(`/app/w/${workspaceId}/settings/fields`);
  await page.getByTestId('field-targets').getByRole('link', { name: 'Pets' }).click();
  await expect(page.getByTestId('fields-list')).toContainText('Breed');
  await page.getByTestId('field-new').click();
  await page.getByTestId('field-form').getByLabel('Name').fill('Microchip number');
  await page.getByTestId('field-save').click();
  await expect(page.getByTestId('fields-list')).toContainText('Microchip number');
});
