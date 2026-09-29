import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Getting started on Home (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6): a new business's owner sees the
 * business's steps, the number first; skips one and takes it back; opens the phone app's links; hides the guide and
 * gets it back from Get help.
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
