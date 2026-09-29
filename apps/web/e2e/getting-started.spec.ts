import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6). On Home, a new business's owner sees the
 * business's steps, the number first; skips one and takes it back; opens the phone app's links; hides the guide and
 * gets it back from Get help. Before that, the quick questions after Create business put the steps in order.
 */
test('a new owner works through Getting started on Home, hides it, and brings it back', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'guide-owner');
  await createBusiness(page, { name: 'Guide Test Plumbing' });

  const guide = page.getByTestId('getting-started');
  await expect(guide).toBeVisible();
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 9 done');
  await expect(guide.getByText('The basics')).toBeVisible();
  await expect(guide.getByText('When you’re ready')).toBeVisible();
  // They skipped the quick questions, so the card offers them.
  await expect(page.getByTestId('getting-started-questions')).toHaveAttribute(
    'href',
    /\/questions\?from=guide$/,
  );

  // The business number comes first, and is the next step: its button is the page's one primary action.
  const number = page.getByTestId('getting-started-number');
  await expect(number).toContainText('Business number & texting');
  await expect(number.getByRole('link', { name: 'Get a number' })).toHaveAttribute(
    'href',
    /\/settings\/texting$/,
  );

  // Skip it: it says so, drops off the count, and Undo takes it back.
  await number.getByRole('button', { name: 'Skip' }).click();
  await expect(number).toHaveAttribute('data-state', 'skipped');
  await expect(number).toContainText('Skipped for now.');
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 8 done');
  await number.getByRole('button', { name: 'Undo' }).click();
  await expect(number).toHaveAttribute('data-state', 'todo');
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 9 done');

  // The phone app's step opens the test links.
  await page
    .getByTestId('getting-started-app')
    .getByRole('button', { name: 'Get the links' })
    .click();
  const links = page.getByTestId('phone-app-links');
  await expect(links.getByRole('link', { name: 'Open TestFlight' })).toHaveAttribute(
    'href',
    'https://testflight.apple.com/join/GBEM8rJU',
  );
  await expect(links.getByRole('link', { name: 'Open Google Play testing' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Hide it: it goes, the toast says where it is, and Get help carries a dot until it's back.
  await page.getByTestId('getting-started-hide').click();
  await expect(page.getByText('Getting started is hidden.', { exact: false })).toBeVisible();
  await expect(guide).toHaveCount(0);
  await expect(page.getByTestId('action-center-intro')).toBeVisible();
  await expect(page.getByTestId('get-help-dot')).toBeVisible();

  await page.getByTestId('get-help').click();
  await page.getByTestId('get-help-guide').click();
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await expect(page.getByTestId('get-help-dot')).toHaveCount(0);

  // "Ask us for help" is still one press away.
  await page.getByTestId('get-help').click();
  await page.getByTestId('get-help-ask').click();
  await expect(page.getByRole('dialog', { name: 'Ask us for help' })).toBeVisible();
});

test('the quick questions put the steps in order, and check the website', async ({ page }) => {
  await signUpAndConfirm(page, 'guide-questions');
  const workspaceId = await createBusiness(page, {
    name: 'Questions Test Roofing',
    answerQuestions: true,
  });
  await expect(page.getByRole('heading', { name: 'A few quick questions' })).toBeVisible();

  // Continuing before answering says what's missing, and how to skip instead.
  await page.getByTestId('questions-continue').click();
  await expect(page.getByText('Pick an answer for each question', { exact: false })).toBeVisible();

  await page.getByTestId('question-goal').getByRole('button', { name: 'Getting paid' }).click();
  await page.getByTestId('question-customers').getByRole('button', { name: 'GoHighLevel' }).click();
  await page.getByTestId('question-team').getByRole('button', { name: 'Just me' }).click();

  // The order follows the answers as they're given: payments second, and no Invite your team.
  const preview = page.getByTestId('questions-preview');
  await expect(preview.getByRole('listitem').nth(1)).toContainText('Connect payments');
  await expect(preview.getByRole('listitem').nth(2)).toContainText('Move them from GoHighLevel');
  await expect(preview).not.toContainText('Invite your team');

  // A website that isn't one is refused, under the field.
  await page.getByLabel('What’s your website?').fill('nope');
  await page.getByTestId('questions-continue').click();
  await expect(page.locator('#website-error')).toHaveText(
    'Enter a full web address, like https://example.com.',
  );
  await page.getByLabel('What’s your website?').fill('questionsroofing.test');
  await page.getByTestId('questions-continue').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));

  // Home follows the answers: payments is a must-do, second; there's no team step; nothing to answer again.
  const rows = page.getByTestId('getting-started').locator('li[data-state]');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'getting-started-payments');
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 8 done');
  await expect(page.getByTestId('getting-started-team')).toHaveCount(0);
  await expect(
    page
      .getByTestId('getting-started-customers')
      .getByRole('link', { name: 'Move from GoHighLevel' }),
  ).toBeVisible();
  await expect(page.getByTestId('getting-started-questions')).toHaveCount(0);
});
