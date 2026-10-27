import { expect, test } from '@playwright/test';
import { addPerson, createCalendar, weekdayAhead } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * New appointment's Customer search finds nobody: "Add “Dana Smith” as a new contact" opens Add a person over it with
 * the name already in, and once she's saved Dana is the customer, booked without leaving the calendar. A number
 * somebody already has offers them instead of a second them.
 */
test('a Customer search that finds nobody adds them as a new contact, then books them', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'cal-new-contact');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  await createCalendar(page, workspaceId, { name: 'Service calls' });
  await addPerson(page, workspaceId, 'Mike', 'Johnson', '713-555-0142');
  const day = weekdayAhead(2);

  await page.goto(`/app/w/${workspaceId}/calendar?date=${day}`);
  await page.getByTestId('calendar-new').click();
  const dialog = page.getByRole('dialog', { name: 'New appointment' });
  await dialog.getByLabel('Date').fill(day);
  await dialog.getByLabel('Start').selectOption('600');

  // Nobody called Dana Smith yet: the search says so and offers to add her, with her name in Add a person.
  await dialog.getByLabel('Customer').fill('Dana Smith');
  await expect(dialog.getByTestId('customer-nobody')).toContainText('No one matches “Dana Smith”.');
  await dialog.getByTestId('customer-add-new').click();
  const add = page.getByRole('dialog', { name: 'Add a person' });
  await expect(add.getByLabel('First name')).toHaveValue('Dana');
  await expect(add.getByLabel('Last name')).toHaveValue('Smith');
  await add.getByLabel('Phone').fill('713-555-0199');
  await add.getByTestId('person-save').click();
  await expect(page.getByText('Dana Smith added.')).toBeVisible();
  await expect(add).toHaveCount(0);

  // Back on New appointment, with everything filled in still there and Dana as the customer.
  await expect(dialog.getByTestId('appointment-customer')).toContainText('Dana Smith');
  await expect(dialog.getByLabel('Start')).toHaveValue('600');
  await dialog.getByTestId('appointment-book').click();
  await expect(page.getByText(/^Booked Service calls with .* at 10:00 AM\.$/)).toBeVisible();
  await expect(page.locator('[data-testid^="appt-"]')).toHaveCount(1);

  // A new name with Mike's number: Add a person offers Mike, and choosing him makes him the customer.
  await page.getByTestId('calendar-new').click();
  await dialog.getByLabel('Customer').fill('Sam Lee');
  await dialog.getByTestId('customer-add-new').click();
  await add.getByLabel('Phone').fill('713-555-0142');
  await expect(add.getByTestId('duplicate-warning')).toContainText('Mike Johnson');
  await add.getByTestId('choose-match').click();
  await expect(add).toHaveCount(0);
  await expect(dialog.getByTestId('appointment-customer')).toContainText('Mike Johnson');
});
