import { expect, test } from '@playwright/test';
import { cardOnHome } from './action-center-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/** Pipeline and workspace settings, the tasks page, and Home's Action Center once customers exist. */
test('owner edits pipelines and the workspace; tasks and the Action Center reflect the work', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'settings-owner');
  const workspaceId = await createBusiness(page, { name: 'Summit Roofing' });

  // Pipelines: add a stage after Contacted, rename the pipeline, move the new stage up, then delete it.
  await page.goto(`/app/w/${workspaceId}/settings/pipelines`);
  await expect(page.getByTestId('pipelines-editor')).toContainText('Sales');
  await page.getByRole('button', { name: 'Add stage' }).click();
  await page.getByLabel('Name').fill('Follow-up');
  await page.getByLabel('Place after').selectOption({ label: 'Contacted' });
  await page.getByTestId('stage-save').click();
  const rows = page.locator('[data-testid^="stage-row-"]');
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(2)).toContainText('Follow-up');
  await rows.nth(2).getByRole('button', { name: 'Move up' }).click();
  await expect(rows.nth(1)).toContainText('Follow-up');
  await rows.nth(1).getByRole('button', { name: 'Delete Follow-up' }).click();
  await page.getByTestId('stage-delete-confirm').click();
  await expect(rows).toHaveCount(5);
  // The last won stage cannot go.
  await rows.nth(3).getByRole('button', { name: 'Delete Won' }).click();
  await page.getByTestId('stage-delete-confirm').click();
  // The dialog's own description also says "at least one"; look for the refusal itself.
  await expect(page.getByText(/needs at least one/i)).toBeVisible();
  await page.keyboard.press('Escape');
  // A second pipeline appears in the board's picker.
  await page.getByTestId('pipeline-new').click();
  await page.getByLabel('Name').fill('Maintenance plans');
  await page.getByTestId('pipeline-create').click();
  await expect(page.getByTestId('pipelines-editor')).toContainText('Maintenance plans');
  await page.goto(`/app/w/${workspaceId}/pipeline`);
  await expect(page.getByLabel('Pipeline')).toBeVisible();
  await page.getByLabel('Pipeline').selectOption({ label: 'Maintenance plans' });
  await expect(page).toHaveURL(/pipeline=/);

  // Workspace settings: rename and change the time zone.
  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  await page.getByLabel('Business name').fill('Summit Roofing & Solar');
  await page.getByLabel('Time zone').selectOption('America/Denver');
  await page.getByTestId('workspace-save').click();
  await expect(page.getByText('Workspace saved.')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}`);
  await expect(page.locator('main')).toContainText('Summit Roofing & Solar');

  // A customer with an overdue task and a lead without a next action feed the home briefing.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Linda');
  await page.getByLabel('Last name').fill('Okafor');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Hail damage repair');
  await page.getByLabel('Value').fill('4100');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('No follow-up scheduled');
  await page.getByTestId('tab-tasks').click();
  await page.getByTestId('task-new').click();
  await page
    .getByTestId('task-form')
    .getByLabel('Task', { exact: true })
    .fill('Send the roof photos');
  await page.getByLabel('Due').fill('2020-01-15');
  await page.getByTestId('task-save').click();
  await expect(page.getByTestId('task-list')).toContainText('Overdue');

  await page.goto(`/app/w/${workspaceId}/tasks`);
  await expect(page.getByTestId('tasks-group-overdue')).toContainText('Send the roof photos');
  await expect(page.getByTestId('tasks-group-overdue')).toContainText('Linda Okafor');
  await page.getByTestId('tasks-group-overdue').getByTestId('task-toggle').click();
  await expect(page.getByTestId('tasks-group-done')).toContainText('Send the roof photos');

  // Home is the Action Center: the lead with no next action waits there with its value; the done task doesn't.
  await page.goto(`/app/w/${workspaceId}`);
  const hail = await cardOnHome(page, workspaceId, 'Hail damage repair');
  await expect(hail).toContainText('No next action');
  await expect(page.getByTestId('attention-affected')).toHaveText('$4,100 affected');
  await cardOnHome(page, workspaceId, 'Send the roof photos', { gone: true });

  // Members see the settings sub-nav without the workspace pages.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(page.getByRole('navigation', { name: 'Settings' })).toContainText('Pipelines');
});
