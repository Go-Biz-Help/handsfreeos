import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/** The phone shell: drawer and bottom bar navigation, the customer page, and the pipeline list with its stage picker. */
test('navigates with the drawer and bottom bar, opens a customer, and moves a lead from the list view', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'mobile-owner');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });

  // Customers sits under More since the calendar joined the bottom bar; the sidebar is hidden on phones.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeHidden();
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'More' })
    .click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Customers' })
    .click();
  await expect(page).toHaveURL(/\/customers$/);
  await expect(page.getByText('No people yet')).toBeVisible();

  // Drawer holds the full navigation.
  await page.getByTestId('mobile-menu').click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Members' })
    .click();
  await expect(page).toHaveURL(/\/members$/);

  // Add a person from the phone; the customer page stacks into one column.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Maria');
  await page.getByLabel('Last name').fill('Santos');
  await page.getByLabel('Phone').fill('281-555-0121');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await expect(page.getByTestId('record-name')).toHaveText('Maria Santos');
  await expect(page.getByTestId('action-text')).toBeVisible();
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Rooftop units');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Rooftop units');

  // The pipeline opens as a list on phones; the stage picker moves the lead. Board view scrolls sideways.
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Pipeline' })
    .click();
  await expect(page.getByTestId('pipeline')).toHaveAttribute('data-view', 'list');
  const row = page.getByTestId('board-list').locator('[data-testid^="lead-row-"]').first();
  const leadId = (await row.getAttribute('data-testid'))!.replace('lead-row-', '');
  await page
    .getByTestId(`stage-picker-${leadId}`)
    .filter({ visible: true })
    .selectOption({ label: 'Contacted' });
  await expect(page.getByTestId('pipeline-summary')).toContainText('1 open lead');
  await page.getByRole('tab', { name: 'Board' }).click();
  await expect(page.getByTestId('pipeline')).toHaveAttribute('data-view', 'board');
  await expect(page.getByTestId('stage-column-contacted')).toContainText('Rooftop units');
  const board = page.getByTestId('board');
  const width = await board.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(width).toBeGreaterThan(200);
  await board.evaluate((el) => el.scrollTo({ left: 600 }));
  await expect(page.getByTestId('stage-column-won')).toBeInViewport();
});
