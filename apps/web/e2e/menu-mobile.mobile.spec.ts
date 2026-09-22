import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/** The same arranged menu on a phone: the drawer scrolls, a group opens in place, and the bottom bar follows. */
test('the phone drawer scrolls, opens a group in place, and drops a hidden place from the bar', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'menu-phone');
  const workspaceId = await createBusiness(page, { name: 'Gulf Coast Glass' });

  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);

  // The drawer's menu scrolls on its own, so the account stays put at the bottom.
  await page.getByTestId('mobile-menu').click();
  const drawer = page.getByTestId('drawer-menu');
  await expect(drawer).toBeVisible();
  expect(await drawer.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  await expect(page.getByTestId('sign-out')).toBeVisible();

  // Arrange it from the phone: the suggested groups, and Pipeline out of the way.
  await drawer.getByTestId('menu-edit').click();
  await page.getByTestId('menu-suggest').click();
  await page
    .getByTestId('menu-row-pipeline')
    .getByLabel(/Move to/)
    .selectOption('hidden');
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();

  // A place taken out of the menu is out of the bottom bar too.
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Calendar']);

  // The group opens in place — a flyout has nowhere to go on a phone — and the drawer shuts behind the link.
  await page.getByTestId('mobile-menu').click();
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.getByRole('link', { name: 'Knowledge' })).toHaveCount(0);
  await nav.getByTestId('menu-group-more').click();
  await expect(nav.getByTestId('menu-group-panel-more')).toBeVisible();
  await nav.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/knowledge$`));
  await expect(page.getByTestId('drawer-menu')).toHaveCount(0);

  // Back in the drawer, the group is already open because the page inside it is the one showing.
  await page.getByTestId('mobile-menu').click();
  await expect(page.getByTestId('menu-group-panel-more')).toBeVisible();
});
