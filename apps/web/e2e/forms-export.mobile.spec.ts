import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { formWithAnswers, JOB_FEEDBACK_HEADING } from './forms';

/**
 * Export to CSV at 390 px (M17): on a phone the Results tab's row wraps, so the button drops under All together and
 * One at a time, whole and inside the screen rather than off its edge, and pressing it downloads the same file the
 * wide screen does (forms-export.spec.ts reads that file closely).
 */
test('exports every answer to a CSV on a phone-sized screen', async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId, formId, slug } = await formWithAnswers(page, 'forms-csv-m');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-results').click();
  const button = page.getByTestId('form-export-csv');
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  // Big enough to press with a thumb.
  expect(box.height).toBeGreaterThanOrEqual(32);

  const downloading = page.waitForEvent('download');
  await button.tap();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^${slug}-answers-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );
  const csv = readFileSync((await download.path())!, 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).split('\r\n');
  expect(lines[0]).toBe(JOB_FEEDBACK_HEADING);
  expect(lines.filter(Boolean)).toHaveLength(3);
});
