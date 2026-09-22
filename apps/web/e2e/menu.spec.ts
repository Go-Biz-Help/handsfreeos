import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The side menu each person arranges: groups that open beside the sidebar, places taken out of the way, a menu
 * that scrolls on its own, and an arrangement that is still there after a reload.
 */

const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' });

/** Arranging the menu is Settings → Side menu; the menu itself holds no row for it. */
async function openMenuEditor(page: Page, workspaceId: string) {
  await page.goto(`/app/w/${workspaceId}/settings`);
  await page.getByTestId('settings-edit-menu').click();
  await expect(page.getByTestId('menu-editor-list')).toBeVisible();
}

test('a person arranges their own side menu: groups, hiding, and it survives a reload', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'menu-owner');
  const workspaceId = await createBusiness(page, { name: 'Lakeside Electric' });

  // Out of the box: every place, one under the other, and the account stays at the bottom while the menu scrolls.
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toBeVisible();
  const menu = page.getByTestId('sidebar-menu');
  await expect(menu).toBeVisible();
  // A window too short for fifteen places. The sidebar is kept to the window and pinned there, so it is the
  // menu that overflows rather than the page growing and taking the account with it.
  await page.setViewportSize({ width: 1280, height: 620 });
  await expect.poll(() => menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1)).toBe(true);
  const aside = page.locator('aside').first();
  expect((await aside.boundingBox())!.height).toBeLessThanOrEqual(620);
  // The account is still reachable on a short screen, because only the menu scrolled.
  await expect(aside.getByTestId('sign-out')).toBeInViewport();
  await page.setViewportSize({ width: 1280, height: 832 });

  // No row for editing in the menu itself: it is Settings → Side menu.
  await expect(nav(page).getByRole('button', { name: /Edit menu/i })).toHaveCount(0);

  // The suggested arrangement: the everyday places stay out, the rest fold into More.
  await openMenuEditor(page, workspaceId);
  await page.getByTestId('menu-suggest').click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();

  // Knowledge is no longer a row of its own; it is one press inside More.
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toHaveCount(0);
  const group = nav(page).getByTestId('menu-group-more');
  await expect(group).toBeVisible();
  await group.click();
  const panel = page.getByTestId('menu-group-panel-more');
  await expect(panel).toBeVisible();
  await panel.getByRole('link', { name: 'Knowledge' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/knowledge$`));
  // The group is lit while one of its places is open.
  await expect(nav(page).getByTestId('menu-group-more')).toHaveClass(/bg-accent-soft/);

  // Hovering opens it too, without taking the keyboard's place.
  await nav(page).getByTestId('menu-group-more').hover();
  await expect(page.getByTestId('menu-group-panel-more')).toBeVisible();
  await page.keyboard.press('Escape');

  // Kept with the account: it is the same menu after a reload.
  await page.reload();
  await expect(nav(page).getByTestId('menu-group-more')).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toHaveCount(0);

  // Name the group, take the audit log out of the menu altogether, and put Reviews back in the menu.
  await openMenuEditor(page, workspaceId);
  await page.getByLabel('Group name').fill('Back office');
  await page
    .getByTestId('menu-row-audit')
    .getByLabel(/Move to/)
    .selectOption('hidden');
  await page
    .getByTestId('menu-row-reviews')
    .getByLabel(/Move to/)
    .selectOption('menu');
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();
  await expect(nav(page).getByTestId('menu-group-more')).toContainText('Back office');
  await expect(nav(page).getByRole('link', { name: 'Reviews' })).toBeVisible();

  // Hidden is not lost: the editor lists it, and the page still opens from a link.
  await openMenuEditor(page, workspaceId);
  await expect(page.getByTestId('menu-hidden-list')).toContainText('Audit log');
  await page.getByTestId('menu-cancel').click();
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(nav(page).getByRole('link', { name: 'Audit log' })).toHaveCount(0);

  // Start over puts every place back, one under the other.
  await openMenuEditor(page, workspaceId);
  await page.getByTestId('menu-reset').click();
  await page.getByTestId('menu-save').click();
  await expect(nav(page).getByRole('link', { name: 'Knowledge' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Audit log' })).toBeVisible();
  await expect(nav(page).getByTestId('menu-group-more')).toHaveCount(0);
});

test('a group is built by hand, moved, and ungrouped again', async ({ page }) => {
  await signUpAndConfirm(page, 'menu-groups');
  const workspaceId = await createBusiness(page, { name: 'Harbor HVAC' });

  await openMenuEditor(page, workspaceId);
  // Two places into a group of their own: the first makes it, the second joins it.
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

  // Settings is last; the group came after it, so move the group up once.
  await groupRow.getByRole('button', { name: 'Move up' }).first().click();
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('Menu saved.')).toBeVisible();

  const links = await nav(page).getByRole('link').allTextContents();
  expect(links).not.toContain('Members');
  expect(links[links.length - 1]).toBe('Settings');
  await nav(page).getByTestId('menu-group-g1').click();
  const panel = page.getByTestId('menu-group-panel-g1');
  await expect(panel.getByRole('link')).toHaveText(['Members', 'Audit log']);
  await page.keyboard.press('Escape');

  // Ungrouping puts both back in the menu where the group stood.
  await openMenuEditor(page, workspaceId);
  await page.getByRole('button', { name: /^Ungroup/ }).click();
  await page.getByTestId('menu-save').click();
  await expect(nav(page).getByTestId('menu-group-g1')).toHaveCount(0);
  const after = await nav(page).getByRole('link').allTextContents();
  expect(after.indexOf('Audit log')).toBe(after.indexOf('Members') + 1);
});
