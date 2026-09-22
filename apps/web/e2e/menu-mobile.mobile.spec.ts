import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/** The same shipped menu on a phone: More opens in place, the drawer scrolls when it has to, and the bar follows. */
test('the phone drawer opens a group in place, scrolls a long menu, and drops a hidden place from the bar', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'menu-phone');
  const workspaceId = await createBusiness(page, { name: 'Gulf Coast Glass' });

  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);

  // The drawer shows the same shipped menu, and no row for editing it.
  await page.getByTestId('mobile-menu').click();
  const drawer = page.getByTestId('drawer-menu');
  await expect(drawer).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  await expect(nav.getByRole('link', { name: 'Knowledge' })).toHaveCount(0);
  await expect(drawer.getByRole('button', { name: /Edit menu/i })).toHaveCount(0);
  // Scoped to the drawer: a test id is a plain CSS match, so it finds the sidebar's copy too, hidden as it is.
  await expect(page.getByRole('dialog').getByTestId('sign-out')).toBeVisible();

  // The group opens in place — a flyout has nowhere to go on a phone — and the drawer shuts behind the link.
  await nav.getByTestId('menu-group-more').click();
  await expect(nav.getByTestId('menu-group-panel-more')).toBeVisible();
  await nav.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/knowledge$`));
  await expect(page.getByTestId('drawer-menu')).toHaveCount(0);

  // Back in the drawer, the group is already open because the page inside it is the one showing.
  await page.getByTestId('mobile-menu').click();
  await expect(page.getByTestId('menu-group-panel-more')).toBeVisible();
  await page.keyboard.press('Escape');

  // Every place in the menu is more than a phone screen holds, so the drawer's menu scrolls on its own and
  // the account stays put at the bottom.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await page.getByTestId('settings-edit-menu').click();
  await page.getByTestId('menu-flatten').click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();
  await page.getByTestId('mobile-menu').click();
  const long = page.getByTestId('drawer-menu');
  await expect(long).toBeVisible();
  await expect.poll(() => long.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  await expect(page.getByRole('dialog').getByTestId('sign-out')).toBeVisible();
  await page.keyboard.press('Escape');

  // A place taken out of the menu is out of the bottom bar too.
  await page.getByTestId('settings-edit-menu').click();
  await page
    .getByTestId('menu-row-pipeline')
    .getByLabel(/Move to/)
    .selectOption('hidden');
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Calendar']);
});
