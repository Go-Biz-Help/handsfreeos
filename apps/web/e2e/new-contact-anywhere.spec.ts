import { expect, test } from '@playwright/test';
import { addPerson } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Every contact picker can add someone new without leaving (core `new-contact.ts`), not just New appointment's
 * (calendar-new-contact.spec.ts): an invoice's Customer and a new lead's Who is it for. "Add “…” as a new contact"
 * shows under what the search found too, since a second Dana may be someone else, and opens Add a person with what
 * was typed already in it. Once saved they're the one picked, with the rest of the screen as it was: saving them
 * doesn't save the lead around them.
 */
test('an invoice and a new lead each add a new contact from their search, and pick them', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'new-contact-anywhere');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  await addPerson(page, workspaceId, 'Dana', 'Smith', '713-555-0142');
  const add = page.getByRole('dialog', { name: 'Add a person' });

  // An invoice: one Dana on file, offered under her all the same; this one is a different Dana.
  await page.goto(`/app/w/${workspaceId}/money/invoices/new`);
  await page.getByTestId('money-person-picker').fill('Dana');
  await expect(page.getByTestId('money-person-Dana Smith')).toBeVisible();
  await expect(page.getByTestId('customer-add-new')).toContainText('Add “Dana” as a new contact');
  await page.getByTestId('money-person-picker').fill('Dana Reyes');
  await expect(page.getByRole('listbox')).toContainText('No one matches “Dana Reyes”.');
  await page.getByTestId('customer-add-new').click();
  await expect(add.getByLabel('First name')).toHaveValue('Dana');
  await expect(add.getByLabel('Last name')).toHaveValue('Reyes');
  await add.getByLabel('Email').fill('dana@reyesbakery.com');
  await add.getByTestId('person-save').click();
  await expect(page.getByText('Dana Reyes added.')).toBeVisible();
  await expect(add).toHaveCount(0);
  // Picked, with her email, and still on the new invoice.
  await expect(page).toHaveURL(/\/money\/invoices\/new/);
  await expect(page.getByText('dana@reyesbakery.com')).toBeVisible();
  await expect(page.getByTestId('money-person-picker')).toHaveCount(0);

  // A new lead: adding the contact inside its form doesn't save the lead before it has a title.
  await page.goto(`/app/w/${workspaceId}/pipeline`);
  await page.getByTestId('pipeline-new-lead').click();
  const lead = page.getByRole('dialog', { name: 'New lead' });
  await lead.getByTestId('record-picker').fill('Sam Lee');
  await lead.getByTestId('customer-add-new').click();
  await expect(add.getByLabel('First name')).toHaveValue('Sam');
  await add.getByLabel('Phone').fill('713-555-0199');
  await add.getByTestId('person-save').click();
  await expect(add).toHaveCount(0);
  await expect(lead.getByTestId('record-picker-value')).toContainText('Sam Lee');
  await expect(lead).toBeVisible();
  await lead.getByLabel('Title').fill('Water heater');
  await lead.getByTestId('lead-save').click();
  await expect(lead).toHaveCount(0);
  await expect(page.getByTestId('stage-column-new')).toContainText('Water heater');

  // A number somebody already has offers them instead, and choosing them picks them.
  await page.getByTestId('pipeline-new-lead').click();
  await lead.getByTestId('record-picker').fill('Danny');
  await lead.getByTestId('customer-add-new').click();
  await add.getByLabel('Phone').fill('713-555-0142');
  await expect(add.getByTestId('duplicate-warning')).toContainText('Dana Smith');
  await add.getByTestId('choose-match').click();
  await expect(add).toHaveCount(0);
  await expect(lead.getByTestId('record-picker-value')).toContainText('Dana Smith');
});
