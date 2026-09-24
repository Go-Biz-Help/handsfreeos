import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { formWithAnswers } from './forms';

/**
 * A form's QR code on the Share tab at 390 px (M17): big enough for somebody standing there to scan straight off the
 * screen, whole and inside it, with Download under it saving the same code as a PNG.
 */
test('shows the QR code big enough to scan on a phone-sized screen, and downloads it', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { workspaceId, formId, slug } = await formWithAnswers(page, 'forms-qr-m');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-share').click();
  const qr = page.getByTestId('form-share-qr');
  await expect(qr).toBeVisible();
  const box = (await qr.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(200);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // Made from the form's link, in this browser: a PNG, not a placeholder.
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

  const downloading = page.waitForEvent('download');
  await page.getByTestId('form-share-qr-download').tap();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`${slug}-qr.png`);
  const png = readFileSync((await download.path())!);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
