import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * On a phone: Workflows is in the drawer (the bar stays at five), the list fits the screen, and a step
 * opens in a bottom sheet to edit, with "Move to…" instead of dragging.
 */
test('on a phone: the workflow list, and a step edited in the bottom sheet', async ({ page }) => {
  await signUpAndConfirm(page, 'wf-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });

  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);
  await bar.getByRole('button', { name: 'More' }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Workflows' })
    .click();
  await expect(page).toHaveURL(/\/workflows$/);
  await expect(page.getByTestId('workflows-empty')).toBeVisible();

  // A recipe from "How do you want to start?".
  await page.getByRole('link', { name: 'Browse recipes' }).click();
  await expect(page.getByRole('heading', { name: 'How do you want to start?' })).toBeVisible();
  await page.getByTestId('recipe-speed_to_lead').click();
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  const workflowId = /workflows\/([0-9a-f-]{36})$/.exec(page.url())![1]!;

  // The list at phone width.
  await page.goto(`/app/w/${workspaceId}/workflows`);
  const row = page.getByTestId(`workflow-row-${workflowId}`);
  await expect(row).toContainText('Speed to lead');
  await expect(row).toContainText('Recipe');
  await expect(row).toContainText('Draft');
  const box = await row.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);

  // The editor: a full-width step list with no drag handles; a tapped step opens in the bottom sheet.
  await row.click();
  await expect(page.getByTestId('workflow-editor')).toBeVisible();
  await expect(page.getByTestId('drag-handle')).toHaveCount(0);
  await expect(page.getByTestId('workflow-rail')).toHaveCount(0);
  await page.getByTestId('step-s_stlwait2').click();
  const sheet = page.getByTestId('step-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('panel-title')).toHaveText('Wait');
  await sheet.getByTestId('wait-amount').fill('3');
  await sheet.getByTestId('sheet-done').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('step-s_stlwait2')).toContainText('Wait 3 days');
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');

  // "Move to…" from the sheet: the last wait goes to the start.
  await page.getByTestId('step-s_stlwait2').click();
  await page.getByTestId('sheet-move').click();
  await page
    .getByTestId('move-dialog')
    .getByRole('button', { name: 'At the start', exact: true })
    .click();
  const order = await page
    .getByTestId('step-list')
    .locator('[role="treeitem"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-tree-id')));
  expect(order.slice(0, 3)).toEqual(['trigger', 's_stlwait2', 's_stltext1']);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');

  // It all saved: a reload shows the same.
  await page.reload();
  await expect(page.getByTestId('step-s_stlwait2')).toContainText('Wait 3 days');
});
