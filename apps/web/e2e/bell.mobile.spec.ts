/**
 * The bell at phone width (20261027012600): beside Ask HandsFreeOS in the header, with nothing scrolling sideways. A
 * new business's owner has nothing under it yet, and the sheet says what will show there. bell.spec.ts covers a push
 * arriving, opening and pressing it.
 */
import { expect, test } from '@playwright/test';
import { pageWidth } from './action-center-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

test('on a phone: the bell in the header, empty until a push comes', async ({ page }) => {
  await signUpAndConfirm(page, 'bell-phone');
  await createBusiness(page, { name: 'Bellwether Heating' });
  const bell = page.getByTestId('mobile-bell');
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAccessibleName('Notifications');
  await expect(page.getByTestId('bell-button')).toBeHidden();
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);

  await bell.click();
  await expect(page.getByTestId('bell-none')).toHaveText(
    'Nothing yet. What HandsFreeOS sends to your phone for this business shows up here for 30 days.',
  );
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bell-none')).toBeHidden();
});
