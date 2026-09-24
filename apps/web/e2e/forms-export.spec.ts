import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { formWithAnswers, JOB_FEEDBACK_HEADING } from './forms';

/**
 * A form's answers as a spreadsheet on the web (M17): the owner opens Results and presses Export to CSV, and the
 * browser downloads one file with a row per answer sheet under a column per question — Excel's byte-order mark first,
 * a comma kept inside its quotes, and a customer's `=1+1` kept as text rather than run as a formula.
 *
 * The form and its answers come from `formWithAnswers` (e2e/forms.ts); forms-export.mobile.spec.ts is the same at 390 px.
 */
test('exports every answer to a CSV the browser downloads', async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId, formId, slug } = await formWithAnswers(page, 'forms-csv');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-results').click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('form-export-csv').click();
  const download = await downloading;

  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^${slug}-answers-\\d{4}-\\d{2}-\\d{2}\\.csv$`),
  );
  const csv = readFileSync((await download.path())!, 'utf8');
  // Excel reads the file as UTF-8 only with the byte-order mark first.
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).split('\r\n');
  expect(lines[0]).toBe(JOB_FEEDBACK_HEADING);
  expect(lines).toHaveLength(4); // the heading, two answer sheets, and the line end after the last
  expect(lines[3]).toBe('');
  const rows = lines.slice(1, 3);
  for (const row of rows) expect(row).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2},/);
  // Filled in the way the phone fills one in, so each says it came from the phone app.
  const rosa = rows.find((r) => r.includes(',Rosa,'))!;
  expect(rosa).toContain(',Phone app,Rosa,');
  expect(rosa).toMatch(/,5,"Late, but fixed it"$/);
  const tom = rows.find((r) => r.includes(',Tom,'))!;
  expect(tom).toMatch(/,4,'=1\+1$/);
});
