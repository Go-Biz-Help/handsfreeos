import { expect, test } from '@playwright/test';
import { cardOnHome } from './action-center-helpers';
import { createBusiness, openFromMenu, signUpAndConfirm } from './helpers';
import {
  apiAs,
  createWorkflow,
  runFor,
  runState,
  signInForApi,
  testAndPublish,
} from './workflow-approval-api';

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
  await openFromMenu(page, 'Workflows');
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

/**
 * On a phone the canvas only views: no "+", menus or dragging, a note that editing happens in Steps, and a
 * tapped step opens read-only in the bottom sheet. Pan and zoom still work, and nothing is saved.
 */
test('on a phone: the canvas is view only', async ({ page }) => {
  await signUpAndConfirm(page, 'wf-mobile-canvas');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  await page.goto(`/app/w/${workspaceId}/workflows/new`);
  await page.getByTestId('recipe-speed_to_lead').click();
  await page.getByTestId('workflow-create').click();
  await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('workflow-editor')).toBeVisible();

  await page.getByTestId('mode-canvas').click();
  const canvas = page.getByTestId('workflow-canvas');
  await expect(canvas).toHaveAttribute('data-ready', 'true');
  await expect(canvas).toHaveAttribute('data-view-only', 'true');
  await expect(page.getByTestId('canvas-view-only')).toHaveText(
    'View only on a phone. Edit in Steps or Describe.',
  );
  const box = (await canvas.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(canvas.locator('[data-testid^="add-"]')).toHaveCount(0);
  await expect(canvas.locator('[data-testid^="node-menu-"]')).toHaveCount(0);
  await expect(canvas.locator('[data-testid^="goto-handle-"]')).toHaveCount(0);
  await expect(canvas.locator('.react-flow__node.draggable')).toHaveCount(0);

  // A tapped step opens read-only in the bottom sheet, without Move to….
  await page.getByTestId('canvas-node-s_stlwait1').tap();
  const sheet = page.getByTestId('step-sheet');
  await expect(sheet.getByTestId('panel-title')).toHaveText('Wait');
  await expect(sheet.getByTestId('wait-amount')).not.toBeEditable();
  await expect(sheet.getByTestId('sheet-move')).toHaveCount(0);
  await expect(sheet.getByTestId('step-menu')).toHaveCount(0);
  await sheet.getByTestId('sheet-done').click();
  await expect(sheet).toBeHidden();

  // Zoom still works, and looking saved nothing.
  const level = page.getByTestId('canvas-zoom-level');
  const was = (await level.textContent())!;
  await page.getByTestId('canvas-zoom-in').click();
  await expect(level).not.toHaveText(was);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
});

/**
 * On a phone, in the dark: an AI-written text waiting for an OK shows on Home, and on the Approvals page its
 * card fits the screen; the text is edited and approved there, and the run carries on with the edited text.
 */
test('on a phone: an AI-written text approved with an edit', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'wf-mobile-appr');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const api = apiAs(await signInForApi(owner.email));
  const ai = 's_mbwrite1';
  const { workflowId } = await createWorkflow(api, workspaceId, 'Reply for approval', [
    {
      id: ai,
      type: 'ai',
      task: 'write',
      prompt: 'Thank them for getting in touch.',
      fallback: 'Thanks for getting in touch!',
    },
    {
      id: 's_mbappr01',
      type: 'approval',
      message: 'Check this before it goes.',
      previewStepId: ai,
    },
    {
      id: 's_mbnote01',
      type: 'action',
      action: 'add_note',
      config: { body: 'Sent: {{ai.message}}' },
    },
  ]);
  await testAndPublish(api, workspaceId, workflowId);
  const { personId } = await api<{ personId: string }>('commands/person.create', {
    workspaceId,
    firstName: 'Pat',
    lastName: 'Nguyen',
  });
  await api('commands/workflow.enrol', { workspaceId, workflowId, personId });
  await expect
    .poll(() => runState(api, workspaceId, workflowId, personId), { timeout: 30_000 })
    .toBe('awaiting_approval');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/app/w/${workspaceId}`);
  // Home's Action Center has the approval: Review opens it on the Approvals page.
  const home = await cardOnHome(page, workspaceId, 'Pat Nguyen');
  await expect(home).toContainText('Approval');
  const homeBox = (await home.boundingBox())!;
  expect(homeBox.x + homeBox.width).toBeLessThanOrEqual(390);
  await expect(home.getByTestId('attention-handle')).toHaveText('Review');
  await home.getByTestId('attention-handle').click();
  await expect(page).toHaveURL(/\/workflows\/approvals$/);

  const card = page.getByTestId('approval-card');
  const field = card.getByTestId('approval-field-message');
  await expect(field).toHaveValue('Hi Pat, thanks for reaching out!');
  const box = (await card.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const edited = 'Hi Pat, thanks for getting in touch! We will call you today.';
  await field.fill(edited);
  await card.getByTestId('approval-approve').tap();
  await expect(page.getByTestId('approvals-empty')).toBeVisible();
  await expect
    .poll(() => runState(api, workspaceId, workflowId, personId), { timeout: 30_000 })
    .toBe('completed:finished');
  const runId = (await runFor(api, workspaceId, workflowId, personId))!.id;
  const got = await api<{ run: { context: { ai?: { message?: string } } } }>(
    'queries/workflow.run_get',
    { workspaceId, runId },
  );
  expect(got.run.context.ai?.message).toBe(edited);
});

/**
 * On a phone: Test from the editor's Test sheet and Publish from the header, then a run in the Runs list and
 * in detail (in the dark), each within 390 px; a tapped step opens what it did in a bottom sheet.
 */
test('on a phone: test and publish from the sheets, and a run at 390 px', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'wf-mobile-run');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const api = apiAs(await signInForApi(owner.email));
  const note = 's_mbnote02';
  const { workflowId } = await createWorkflow(api, workspaceId, 'Welcome note', [
    {
      id: note,
      type: 'action',
      action: 'add_note',
      config: { body: 'Welcome aboard, {{person.first_name}}!' },
    },
  ]);
  const { personId } = await api<{ personId: string }>('commands/person.create', {
    workspaceId,
    firstName: 'Pat',
    lastName: 'Nguyen',
  });
  const fits = async () =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

  // Test in the Test sheet, then Publish from the header.
  await page.goto(`/app/w/${workspaceId}/workflows/${workflowId}`);
  await expect(page.getByTestId('workflow-editor')).toBeVisible();
  await expect(page.getByTestId('workflow-rail')).toHaveCount(0);
  await expect(page.getByTestId('workflow-publish')).toBeDisabled();
  await page.getByTestId('test-open').click();
  const sheet = page.getByTestId('step-sheet');
  await expect(sheet.getByTestId('workflow-test')).toBeVisible();
  await sheet.getByTestId('test-run').click();
  await expect(sheet.getByTestId('test-result')).toHaveAttribute('data-outcome', 'passed', {
    timeout: 60_000,
  });
  const sheetBox = (await sheet.boundingBox())!;
  expect(sheetBox.x + sheetBox.width).toBeLessThanOrEqual(390);
  await sheet.getByTestId('test-sheet-done').click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('publish-gate')).toHaveText('Tested, ready to publish');
  await page.getByTestId('workflow-publish').click();
  const publish = page.getByRole('dialog', { name: 'Publish version 1?' });
  const dialogBox = (await publish.boundingBox())!;
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);
  await publish.getByTestId('publish-confirm').click();
  await expect(page.getByTestId('version-note')).toHaveText('Version 1 is live');
  await fits();

  // A run in the Runs list and in detail, in the dark.
  await api('commands/workflow.enrol', { workspaceId, workflowId, personId });
  await expect
    .poll(() => runState(api, workspaceId, workflowId, personId), { timeout: 30_000 })
    .toBe('completed:finished');
  const runId = (await runFor(api, workspaceId, workflowId, personId))!.id;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/app/w/${workspaceId}/workflows/runs`);
  const row = page.getByTestId(`run-row-${runId}`);
  await expect(row).toContainText('Pat Nguyen');
  expect((await row.boundingBox())!.width).toBeLessThanOrEqual(390);
  await fits();
  await row.click();
  await expect(page.getByTestId('run-detail')).toHaveAttribute('data-status', 'completed');
  await fits();
  await page.getByTestId(`step-${note}`).click();
  const stepSheet = page.getByTestId('run-step-sheet');
  await expect(stepSheet.getByTestId('run-step-note')).toHaveText('Added the note');
});
