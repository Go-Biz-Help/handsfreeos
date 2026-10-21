import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Search everything on a phone-sized screen (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Web on a phone-width
 * screen"): the header's search button opens the Search page, titled "Search" with Back, with its box focused. In the
 * Inbox it keeps its sheet that searches conversations (decision 31), which ends with Search everything for what was
 * typed. What's typed only ever travels after `#`.
 */
test('the header opens the Search page outside the Inbox, and the Inbox keeps Search conversations', async ({
  page,
}) => {
  const { email } = await signUpAndConfirm(page, 'search-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'person.create', {
    workspaceId,
    firstName: 'Dana',
    lastName: 'Smith',
    phone: '(504) 555-0142',
  });

  // On Home the header's button is Search everything, and opens the Search page with its box focused.
  await page.goto(`/app/w/${workspaceId}`);
  const header = page.locator('header').first();
  const button = header.getByTestId('mobile-search');
  await expect(button).toHaveAccessibleName('Search everything');
  await button.click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/search$`));
  await expect(header.getByText('Search', { exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Back' })).toBeVisible();
  // The page has its own box, so the header offers none there.
  await expect(header.getByTestId('mobile-search')).toHaveCount(0);
  const box = page.getByTestId('search-page-input');
  await expect(box).toBeFocused();
  await box.fill('dana');
  await expect(page).toHaveURL(new RegExp(`/search#q=dana$`));
  await expect(
    page.getByTestId('search-card-contacts').getByTestId('search-row-contacts'),
  ).toHaveCount(1);
  // Back leaves the Search page for where it was opened from.
  await header.getByRole('button', { name: 'Back' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));

  // In the Inbox the button searches conversations, and the sheet ends with Search everything for what was typed.
  await page.goto(`/app/w/${workspaceId}/inbox`);
  const inboxButton = header.getByTestId('mobile-search');
  await expect(inboxButton).toHaveAccessibleName('Search conversations');
  await inboxButton.click();
  const sheet = page.getByRole('dialog', { name: 'Search conversations' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('mobile-search-everything')).toHaveCount(0);
  await sheet.getByLabel('Search conversations').fill('dana');
  const everything = sheet.getByTestId('mobile-search-everything');
  await expect(everything).toHaveText('Search everything for “dana”');
  await everything.click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/search#q=dana$`));
  await expect(page.getByTestId('search-page-input')).toHaveValue('dana');
  await expect(page.getByTestId('search-card-contacts')).toContainText('Dana Smith');

  // Left with its sheet open (the browser's Back, which a sheet doesn't stop), the Inbox doesn't open it again unasked.
  const bar = page.getByRole('navigation', { name: 'Primary' });
  await bar.getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/inbox$`));
  await header.getByTestId('mobile-search').click();
  await sheet.getByLabel('Search conversations').fill('dana');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/search#q=dana$`));
  await expect(sheet).toBeHidden();
  await bar.getByRole('link', { name: 'Inbox' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/inbox$`));
  await expect(header.getByTestId('mobile-search')).toHaveAccessibleName('Search conversations');
  await expect(sheet).toBeHidden();
});
