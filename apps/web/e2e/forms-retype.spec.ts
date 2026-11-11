import { expect, test } from '@playwright/test';
import { formWithAnswers } from './forms';

/**
 * Retyping a question in the form editor (docs/forms.md, "The editor lets a box the form needs be emptied"): selecting
 * all of "What does it ask?" and pressing Backspace empties the box, with no "Write the question." refusal and no
 * letter left behind, and the form keeps its last words until the first letter of the new ones.
 */
test('empties a question’s words to retype them', async ({ page }) => {
  test.setTimeout(120_000);
  const { workspaceId, formId } = await formWithAnswers(page, 'forms-retype');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  const rows = page.getByTestId('question-row');
  await rows.filter({ hasText: 'Anything else?' }).getByRole('button').first().click();
  const box = page.locator('#q-title');
  await expect(box).toHaveValue('Anything else?');

  await box.click();
  await box.press('ControlOrMeta+a');
  await box.press('Backspace');
  await expect(box).toHaveValue('');
  await expect(page.getByText('Write the question.')).toHaveCount(0);
  await expect(page.getByText('Until you do, the form keeps “Anything else?”.')).toBeVisible();
  // Nothing was sent while it was empty: the list still shows the words the form keeps.
  await expect(rows.filter({ hasText: 'Anything else?' })).toHaveCount(1);

  await box.pressSequentially('Tell us about the job');
  await expect(box).toHaveValue('Tell us about the job');
  await expect(rows.filter({ hasText: 'Tell us about the job' })).toHaveCount(1);
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });

  await page.reload();
  await expect(rows.filter({ hasText: 'Tell us about the job' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'Anything else?' })).toHaveCount(0);
});
