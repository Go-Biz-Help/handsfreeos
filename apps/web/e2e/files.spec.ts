import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/** A photo uploaded from the customer page lands in Storage, on the Files tab and on the timeline. */
test('uploads a photo to a person and sees it on the timeline', async ({ page }) => {
  await signUpAndConfirm(page, 'files-owner');
  const workspaceId = await createBusiness(page, { name: 'Summit Roofing' });
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Linda');
  await page.getByLabel('Last name').fill('Okafor');
  await page.getByTestId('person-save').click();
  await expect(page).toHaveURL(/\/customers\/people\/[0-9a-f-]{36}$/);

  await page.getByTestId('action-file').click();
  await page
    .getByTestId('file-input')
    .setInputFiles(fileURLToPath(new URL('./fixtures/roof.png', import.meta.url)));
  await expect(page.getByTestId('file-grid')).toContainText('roof.png');
  await expect(page.getByTestId('tab-files')).toContainText('Files · 1');
  // The thumbnail is served by Storage through a signed URL the browser fetched with its own session.
  const img = page.getByTestId('file-grid').locator('img');
  await expect(img).toHaveAttribute('src', /\/storage\/v1\/object\/sign\/attachments\//);
  await expect(img).toHaveJSProperty('naturalWidth', 64);

  await page.getByTestId('tab-timeline').click();
  await expect(page.getByTestId('timeline-system-file_added')).toContainText('uploaded a file');
  await expect(page.getByTestId('timeline-system-file_added')).toContainText('roof.png');

  // Files are blocked at the type allowlist before anything is reserved.
  await page.getByTestId('tab-files').click();
  await page
    .getByTestId('file-input')
    .setInputFiles({ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByText('evil.svg: that file type is not supported.')).toBeVisible();

  // Owners can remove a file; the tile disappears and the removal is audited.
  await page.getByRole('button', { name: 'File actions' }).click();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(page.getByTestId('file-grid')).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByText('uploaded roof.png')).toBeVisible();
  await expect(page.getByText('removed the file roof.png')).toBeVisible();
});
