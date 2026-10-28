import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

const FIXTURE = fileURLToPath(new URL('../../worker/fixtures/customers.csv', import.meta.url));

/** The four-step wizard imports the fixture; progress is live; one row updates an existing person. */
test('imports a CSV of people through the wizard, updating a duplicate', async ({ page }) => {
  await signUpAndConfirm(page, 'import-owner');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });

  // Sarah exists already, without an email; the file has hers.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Sarah');
  await page.getByLabel('Last name').fill('Alvarez');
  await page.getByLabel('Phone').fill('281-555-0199');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\//);

  await page.goto(`/app/w/${workspaceId}/imports/new`);
  await page.getByTestId('import-file').setInputFiles(FIXTURE);
  await expect(page.getByTestId('import-file-summary')).toContainText('9 rows · 11 columns');
  await page.getByTestId('import-next').click();

  // Guessed mapping, with the notes column checked by hand.
  await expect(page.getByTestId('import-step-map')).toBeVisible();
  await expect(page.getByLabel('Field for Cell')).toHaveValue('phone');
  await expect(page.getByLabel('Field for Email Address')).toHaveValue('email');
  await expect(page.getByLabel('Field for Tags')).toHaveValue('tags');
  await page.getByLabel('Field for Notes').selectOption('notes');
  await page.getByTestId('import-next').click();

  await expect(page.getByTestId('import-step-preview')).toContainText('Mike Johnson');
  await expect(page.getByTestId('import-step-preview')).toContainText('bad email · error');
  await page.getByTestId('import-match-update').click();
  await page.getByTestId('import-run').click();

  // The worker runs it; the page follows along and shows the result.
  const progress = page.getByTestId('import-progress');
  await expect(progress).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('import-result')).toContainText('4');
  await expect(page.getByTestId('import-errors')).toContainText('not-an-email');

  // Sarah was updated, not duplicated; Robert came in with his company and tag.
  await page.goto(`/app/w/${workspaceId}/customers?q=alvarez`);
  await expect(page.getByTestId('people-table')).toContainText('salvarez@example.com');
  await expect(page.getByTestId('people-table').locator('tbody tr')).toHaveCount(1);
  await page.goto(`/app/w/${workspaceId}/customers?q=chen`);
  await expect(page.getByTestId('people-table')).toContainText('ABC Dental');
  await expect(page.getByTestId('people-table')).toContainText('Commercial');

  // The audit log tells the story with the system actor.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByText('finished importing customers.csv')).toBeVisible();
  await expect(page.getByText('started importing customers.csv')).toBeVisible();
});

/** A file's "Agreed to calls" column marks who the AI teammate may call, and where they agreed. */
test('marks who agreed to calls from the file, with where they agreed', async ({ page }) => {
  await signUpAndConfirm(page, 'import-calls');
  const workspaceId = await createBusiness(page, { name: 'Lone Star Builders' });

  await page.goto(`/app/w/${workspaceId}/imports/new`);
  await page.getByTestId('import-file').setInputFiles({
    name: 'leads.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Name,Phone,Agreed to calls\nAnn Lee,713-555-0191,Yes\nBo Diaz,713-555-0192,No\n',
    ),
  });
  await page.getByTestId('import-next').click();
  await expect(page.getByLabel('Field for Agreed to calls')).toHaveValue('call_consent');
  await page.getByTestId('import-next').click();

  await expect(page.getByTestId('import-preview-calls')).toHaveText(['Agreed', 'No calls']);
  // A yes needs where they agreed before the import runs.
  await expect(page.getByTestId('import-run')).toBeDisabled();
  await page.getByTestId('import-call-where').fill('Website form, Oct 2026');
  await page.getByTestId('import-run').click();
  await expect(page.getByTestId('import-progress')).toHaveAttribute('data-status', 'done', {
    timeout: 30_000,
  });

  await page.goto(`/app/w/${workspaceId}/customers?q=lee`);
  await page.getByTestId('people-table').getByRole('link').filter({ hasText: 'Ann Lee' }).click();
  await expect(page).toHaveURL(/\/customers\/people\//);
  await page.getByTestId('tab-details').click();
  await expect(page.getByTestId('call-consent-value')).toHaveText(
    'Agreed in writing (Website form, Oct 2026)',
  );

  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(
    page.getByText('started importing leads.csv, with who agreed to calls'),
  ).toBeVisible();
});
