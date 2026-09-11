import { expect, test } from '@playwright/test';
import { createBusiness, signIn, signUpAndConfirm } from './helpers';

/** Two open pipelines: a move in one shows up in the other within two seconds, without reloading. */
test('a teammate sees a lead move within two seconds', async ({ browser, page }) => {
  const owner = await signUpAndConfirm(page, 'live-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  // A person and a lead to move.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Angela');
  await page.getByLabel('Last name').fill('Brooks');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Attic insulation');
  await page.getByLabel('Value').fill('2400');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Attic insulation');

  // The second browser is the same person on another device, watching the board.
  const other = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const watcher = await other.newPage();
  await signIn(watcher, owner.email);
  await watcher.goto(`/app/w/${workspaceId}/pipeline`);
  await expect(watcher.getByTestId('stage-column-new')).toContainText('Attic insulation');
  // Give the private channel a moment to join before the move happens.
  await watcher.waitForTimeout(1500);

  // The first browser moves it from the list view's stage picker.
  await page.goto(`/app/w/${workspaceId}/pipeline?view=list`);
  const row = page.getByTestId('board-list').locator('[data-testid^="lead-row-"]').first();
  const leadId = (await row.getAttribute('data-testid'))!.replace('lead-row-', '');
  await page
    .getByTestId(`stage-picker-${leadId}`)
    .filter({ visible: true })
    .selectOption({ label: 'Contacted' });

  const started = Date.now();
  await expect(watcher.getByTestId('stage-column-contacted')).toContainText('Attic insulation', {
    timeout: 5000,
  });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(2000 + 500);
  await expect(watcher.getByTestId('stage-column-new')).not.toContainText('Attic insulation');
  await other.close();
});
