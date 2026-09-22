import { expect, test } from '@playwright/test';
import { createBusiness, openFromMenu, signUpAndConfirm } from './helpers';

/**
 * On a phone: Knowledge is in the drawer (the bar stays at five), its pages fit 390 px with the subnav
 * scrolling sideways, and an FAQ can be added and read.
 */
test('on a phone: Knowledge from the drawer, the overview and an FAQ fit the screen', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'kb-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });

  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);
  await bar.getByRole('button', { name: 'More' }).click();
  await openFromMenu(page, 'Knowledge');
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/knowledge$`));

  const width = () => page.evaluate(() => document.documentElement.scrollWidth);
  const card = page.getByTestId('profile-card');
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId('try-it')).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);

  // Every tab of the subnav is reachable.
  const sub = page.getByRole('navigation', { name: 'Knowledge' });
  await sub.getByRole('link', { name: 'Suggestions' }).click();
  await expect(page).toHaveURL(/\/knowledge\/suggestions$/);
  await expect(page.getByTestId('suggestions-empty')).toBeVisible();
  await sub.getByRole('link', { name: 'Website' }).click();
  await expect(page.getByTestId('website-url')).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);
  await sub.getByRole('link', { name: 'Items' }).click();
  await expect(page.getByTestId('items-empty')).toBeVisible();

  // An FAQ from the header, then the list.
  await page.getByTestId('knowledge-add-faq').click();
  await page.getByTestId('item-title').fill('Do you clear drains the same day?');
  await page.getByTestId('item-body').fill('Yes, when you call before noon.');
  await page.getByTestId('item-publish').click();
  await expect(page.getByTestId('item-status')).toHaveText('Published');
  expect(await width()).toBeLessThanOrEqual(390);
  await page.getByRole('link', { name: 'All items' }).click();
  const row = page.getByTestId('items-list').getByRole('link').first();
  await expect(row).toContainText('Do you clear drains the same day?');
  expect((await row.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await width()).toBeLessThanOrEqual(390);
});
