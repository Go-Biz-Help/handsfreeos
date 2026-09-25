import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Settings → Tags (0107): the AI goes through every customer with the scripted stand-in model and puts on the tag
 * their record fits, the page follows the pass to its end, and the log below lists each change with its reason.
 * The audit log names the AI and the customer.
 */

async function addCustomer(page: Page, workspaceId: string, first: string, notes: string) {
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill(first);
  await page.getByLabel('Last name').fill('Tagtest');
  await page.getByText('Add source and notes').click();
  await page.getByLabel('Notes').fill(notes);
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
}

test('the AI goes through the whole customer list, tags who fits, and says why', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'ai-tags-owner');
  const workspaceId = await createBusiness(page, { name: 'Sunny Solar & Air' });

  // No tags yet: nothing for the AI to put on.
  await page.goto(`/app/w/${workspaceId}/settings/tags`);
  await expect(page.getByRole('navigation', { name: 'Settings' })).toContainText('Tags');
  await expect(page.getByTestId('ai-tagging')).toContainText(
    'Add a tag on any customer’s page first',
  );

  await addCustomer(page, workspaceId, 'Rosa', 'Asked about Solar panels for the barn');
  await addCustomer(page, workspaceId, 'Sam', 'Furnace tune-up every fall');
  // The tag, made on Sam's page and taken off again, so nobody has it yet.
  await page.getByTestId('tag-picker').getByRole('button').first().click();
  await page.getByTestId('tag-new').click();
  await page.getByLabel('Tag name').fill('Solar');
  await page.getByTestId('tag-create').click();
  await expect(page.getByTestId('tag-picker')).toContainText('Solar');
  await page.getByTestId('tag-picker').getByRole('button').first().click();
  await page.getByRole('menuitemcheckbox', { name: 'Solar' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tag-picker')).not.toContainText('Solar');

  await page.goto(`/app/w/${workspaceId}/settings/tags`);
  await expect(page.getByTestId('tag-list')).toContainText('Solar');
  await page.getByLabel('What to look for (optional)').fill('Anyone who wants solar gets Solar.');
  await page.getByRole('button', { name: 'Go through my customers' }).click();
  await expect(page.getByText('The AI is going through 2 customers.')).toBeVisible();

  // The page follows the pass until it's done, then shows what changed and why.
  const log = page.getByTestId('ai-tagging-log');
  await expect(log).toContainText('Rosa Tagtest', { timeout: 45_000 });
  await expect(log).toContainText('Put on Solar — Mentioned “Solar”');
  await expect(log).not.toContainText('Sam Tagtest');
  await expect(page.getByTestId('ai-tagging')).toContainText('2 looked at, 1 changed');

  // The audit log names the AI, the customer and the reason.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByText('added the tag Solar on Rosa Tagtest').first()).toBeVisible();
  await expect(page.getByText('HandsFreeOS AI').first()).toBeVisible();
});
