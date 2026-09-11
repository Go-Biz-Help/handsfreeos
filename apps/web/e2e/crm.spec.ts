import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Milestone 2 CRM core: a company and a person are added (with the duplicate warning), a lead is created
 * from the customer page, notes and tasks land on the timeline, and archive/restore behaves.
 */
test('company → person with duplicate warning → lead → note → task → archive and restore → audit', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'crm-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  // A company from the Companies tab.
  await page.goto(`/app/w/${workspaceId}/customers?tab=companies`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('Company name').fill('ABC Dental');
  await page.getByLabel('Phone').fill('713-555-0110');
  await page.getByTestId('company-save').click();
  await expect(page).toHaveURL(/\/customers\/companies\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('record-name')).toHaveText('ABC Dental');
  await expect(page.getByTestId('timeline-system-created')).toBeVisible();

  // A person, linked to the company, with a tag created on the spot.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await expect(page.getByText('No people yet')).toBeVisible();
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Mike');
  await page.getByLabel('Last name').fill('Johnson');
  await page.getByLabel('Phone').fill('(713) 555-0142');
  await page.getByLabel('Email').fill('Mike.Johnson@example.com');
  await page.getByLabel('Company').selectOption({ label: 'ABC Dental' });
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.getByTestId('tag-new').click();
  await page.getByLabel('Tag name').fill('Residential');
  await page.getByTestId('tag-create').click();
  await expect(page.getByTestId('tag-picker')).toContainText('Residential');
  await expect(page.getByTestId('person-save')).toBeVisible();
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  const personUrl = page.url();
  await expect(page.getByTestId('record-name')).toHaveText('Mike Johnson');
  await expect(page.getByRole('link', { name: '(713) 555-0142' })).toHaveAttribute(
    'href',
    'tel:+17135550142',
  );
  await expect(page.getByRole('link', { name: 'mike.johnson@example.com' })).toBeVisible();
  await expect(page.getByTestId('tag-picker')).toContainText('Residential');

  // The same phone again warns before saving; "save anyway" creates a second record.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Michael');
  await page.getByLabel('Phone').fill('713 555 0142');
  await expect(page.getByTestId('duplicate-warning')).toContainText('Mike Johnson already exists');
  await page.getByTestId('save-anyway').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('record-name')).toHaveText('Michael');

  // Search finds both; the list shows the company.
  await page.goto(`/app/w/${workspaceId}/customers?q=0142`);
  await expect(page.getByTestId('people-table')).toContainText('Mike Johnson');
  await expect(page.getByTestId('people-table')).toContainText('Michael');
  await expect(page.getByTestId('people-table')).toContainText('ABC Dental');

  // A lead from the customer page; without a next action it is flagged.
  await page.goto(personUrl);
  await page.getByTestId('action-lead').click();
  await page.getByLabel('Title').fill('Roof replacement');
  await page.getByLabel('Value').fill('12,500');
  await page.getByTestId('lead-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Roof replacement');
  await expect(page.getByTestId('open-lead-card')).toContainText('$12,500');
  await expect(page.getByTestId('open-lead-card')).toContainText('New');
  await expect(page.getByTestId('open-lead-card')).toContainText('No follow-up scheduled');
  await page.getByTestId('set-next-action').click();
  await page
    .getByTestId('next-action-form')
    .getByLabel('Next action', { exact: true })
    .fill('Send the estimate');
  await page.getByTestId('next-action-save').click();
  await expect(page.getByTestId('open-lead-card')).toContainText('Send the estimate');
  await expect(page.getByTestId('open-lead-card')).not.toContainText('No follow-up scheduled');
  await expect(page.getByTestId('tab-leads')).toContainText('Leads · 1');

  // A note and a call go on the timeline.
  await page.getByTestId('action-note').click();
  await page.getByLabel('Note').fill('Prefers texts over calls. Gate code 4471.');
  await page.getByTestId('activity-save').click();
  await expect(page.getByTestId('timeline-note')).toContainText('Gate code 4471');
  await page.getByTestId('action-call').click();
  await page.getByLabel('What was said').fill('Walked the roof together.');
  await page.getByTestId('activity-save').click();
  await expect(page.getByTestId('timeline-call')).toContainText('logged a call');

  // A task, completed inline, shows on the timeline as done.
  await page.getByTestId('tab-tasks').click();
  await page.getByTestId('task-new').click();
  await page
    .getByTestId('task-form')
    .getByLabel('Task', { exact: true })
    .fill('Call Mike about the estimate');
  await page.getByTestId('task-save').click();
  await expect(page.getByTestId('task-list')).toContainText('Call Mike about the estimate');
  await expect(page.getByTestId('tab-tasks')).toContainText('Tasks · 1');
  await page.getByTestId('task-toggle').click();
  await expect(page.getByTestId('tab-tasks')).toContainText('Tasks · 0');
  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('timeline-system-task_done')).toContainText('completed a task');

  // Archiving is blocked by the open lead until forced; restore brings it back.
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-archive').click();
  await page.getByTestId('archive-confirm').click();
  await expect(page.getByTestId('archive-blocked')).toContainText('1 open lead');
  await page.getByTestId('archive-force').click();
  await expect(page.getByTestId('archived-notice')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/customers`);
  await expect(page.getByTestId('people-table')).not.toContainText('Mike Johnson');
  await page.getByTestId('customers-archived').click();
  await expect(page.getByTestId('people-table')).toContainText('Mike Johnson');
  await page.goto(personUrl);
  await page.getByTestId('record-menu').click();
  await page.getByTestId('record-archive').click();
  await page.getByTestId('restore-confirm').click();
  await expect(page.getByTestId('archived-notice')).toHaveCount(0);

  // Everything above is in the audit log, in plain English.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByText('added Mike Johnson')).toBeVisible();
  await expect(page.getByText('created the lead Roof replacement in New')).toBeVisible();
  await expect(page.getByText('completed the task Call Mike about the estimate')).toBeVisible();
  await expect(page.getByText('archived Mike Johnson')).toBeVisible();
  await expect(page.getByText('restored Mike Johnson')).toBeVisible();
});

test('a member sees customers but cannot archive; the search field in the shell opens the list', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'crm-member');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  await page.goto(`/app/w/${workspaceId}`);
  await page.getByTestId('shell-search').fill('Ramsey');
  await page.getByTestId('shell-search').press('Enter');
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/customers\\?q=Ramsey`));
  await expect(page.getByTestId('customers-search')).toHaveValue('Ramsey');
  await expect(page.getByText('No people match')).toBeVisible();
  await expectEmptyToHaveAdd(page);
});

async function expectEmptyToHaveAdd(page: Page) {
  await page.goto(page.url().split('?')[0]!);
  await expect(page.getByRole('button', { name: 'Add a person' })).toBeVisible();
}
