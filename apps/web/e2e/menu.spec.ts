import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The side menu: what it ships as, the groups that open beside the sidebar, places taken out of the way, a
 * menu that scrolls on its own, and an arrangement that is still there after a reload.
 */

const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

/** Arranging the menu is Settings → Side menu; the menu itself holds no row for it. */
async function openMenuEditor(page: Page, workspaceId: string) {
  await page.goto(`/app/w/${workspaceId}/settings`);
  await page.getByTestId('settings-edit-menu').click();
  await expect(page.getByTestId('menu-editor-list')).toBeVisible();
}

test('the menu ships grouped, opens More, and keeps what a person arranges', async ({ page }) => {
  await signUpAndConfirm(page, 'menu-owner');
  const workspaceId = await createBusiness(page, { name: 'Lakeside Electric' });

  // Out of the box: the everyday places stand on their own and the rest are under More. Nine rows, not
  // fifteen, without anybody arranging anything.
  await expect(nav(page).getByRole('link')).toHaveText([
    'Home',
    'Inbox',
    'Customers',
    'Pipeline',
    'Calendar',
    'Money',
    'Tasks',
    'Settings',
  ]);
  await expect(nav(page).getByTestId('menu-group-more')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toHaveCount(0);

  // No row for editing in the menu itself: it is Settings → Side menu.
  await expect(nav(page).getByRole('button', { name: /Edit menu/i })).toHaveCount(0);

  // A window too short even for nine. The sidebar is kept to the window and pinned there, so it is the menu
  // that overflows rather than the page growing and taking the account with it.
  const menu = page.getByTestId('sidebar-menu');
  await expect(menu).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 560 });
  await expect.poll(() => menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  const aside = page.locator('aside').first();
  expect((await aside.boundingBox())!.height).toBeLessThanOrEqual(560);
  await expect(aside.getByTestId('sign-out')).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 832 });

  // More opens on a press, and its places go where they say.
  await nav(page).getByTestId('menu-group-more').click();
  const panel = page.getByTestId('menu-group-panel-more');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('link')).toHaveText([
    'Workflows',
    'Forms',
    'Reviews',
    'Knowledge',
    'AI teammate',
    'Members',
    'Audit log',
  ]);
  await panel.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/knowledge$`));
  // The group is lit while one of its places is open.
  await expect(nav(page).getByTestId('menu-group-more')).toHaveClass(/bg-accent-soft/);

  // Hovering opens it too, without taking the keyboard's place.
  await nav(page).getByTestId('menu-group-more').hover();
  await expect(page.getByTestId('menu-group-panel-more')).toBeVisible();
  await page.keyboard.press('Escape');

  // One under the other, for anybody who wants every place in the menu.
  await openMenuEditor(page, workspaceId);
  await page.getByTestId('menu-flatten').click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toBeVisible();
  await expect(nav(page).getByTestId('menu-group-more')).toHaveCount(0);

  // Kept with the account: an arrangement is still there after a reload, the shipped one is not assumed.
  await page.reload();
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toBeVisible();
  await expect(nav(page).getByTestId('menu-group-more')).toHaveCount(0);

  // Take the audit log out of the menu altogether.
  await openMenuEditor(page, workspaceId);
  await page
    .getByTestId('menu-row-audit')
    .getByLabel(/Move to/)
    .selectOption('hidden');
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // Hidden is not lost: the editor lists it, and the page still opens from a link.
  await openMenuEditor(page, workspaceId);
  await expect(page.getByTestId('menu-hidden-list')).toContainText('Audit log');
  await page.getByTestId('menu-cancel').click();
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(nav(page).getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // Start over is the menu as it ships, groups and all, with nothing left hidden.
  await openMenuEditor(page, workspaceId);
  await page.getByTestId('menu-reset').click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();
  await expect(nav(page).getByTestId('menu-group-more')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toHaveCount(0);
  await nav(page).getByTestId('menu-group-more').click();
  await expect(page.getByTestId('menu-group-panel-more').getByRole('link')).toContainText([
    'Audit log',
  ]);
});

test('a group is built by hand, named, moved, and ungrouped again', async ({ page }) => {
  await signUpAndConfirm(page, 'menu-groups');
  const workspaceId = await createBusiness(page, { name: 'Harbor HVAC' });

  // Members and the audit log ship inside More; here they get a group of their own instead.
  await openMenuEditor(page, workspaceId);
  await page
    .getByTestId('menu-row-members')
    .getByLabel(/Move to/)
    .selectOption('new');
  const groupRow = page.getByTestId('menu-group-row-g1');
  await expect(groupRow).toContainText('1 place');
  await page
    .getByTestId('menu-row-audit')
    .getByLabel(/Move to/)
    .selectOption('g1');
  await expect(groupRow).toContainText('2 places');
  await page.getByLabel('Group name').last().fill('Back office');

  // A new group goes to the end, after Settings; one press moves it above.
  await groupRow.getByRole('button', { name: 'Move up' }).first().click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();

  const links = await nav(page).getByRole('link').allTextContents();
  expect(links).not.toContain('Members');
  expect(links[links.length - 1]).toBe('Settings');
  await expect(nav(page).getByTestId('menu-group-g1')).toContainText('Back office');
  await nav(page).getByTestId('menu-group-g1').click();
  await expect(page.getByTestId('menu-group-panel-g1').getByRole('link')).toHaveText([
    'Members',
    'Audit log',
  ]);
  await page.keyboard.press('Escape');

  // Ungrouping puts both back in the menu where the group stood.
  await openMenuEditor(page, workspaceId);
  await page.getByRole('button', { name: 'Ungroup Back office' }).click();
  await page.getByTestId('menu-save').click();
  await expect(nav(page).getByTestId('menu-group-g1')).toHaveCount(0);
  const after = await nav(page).getByRole('link').allTextContents();
  expect(after.indexOf('Audit log')).toBe(after.indexOf('Members') + 1);
});
