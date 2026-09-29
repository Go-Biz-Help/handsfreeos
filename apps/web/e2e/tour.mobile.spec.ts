import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The tour on a 390 × 844 phone (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6): it points at the bottom bar,
 * above it, and skips Ask HandsFreeOS, which the bottom bar doesn't have. Nothing scrolls sideways.
 */
test('on a phone: the tour points at the bottom bar', async ({ page }) => {
  await signUpAndConfirm(page, 'tour-phone');
  await createBusiness(page, { name: 'Tour Phone Plumbing' });
  await page
    .getByTestId('getting-started-tour')
    .getByRole('button', { name: 'Take the tour' })
    .click();

  const tour = page.getByTestId('tour');
  const bar = page.getByRole('navigation', { name: 'Primary' });
  const stops: string[] = [];
  for (let i = 0; i < 4; i++) {
    await expect(tour).toContainText(`${i + 1} of 4`);
    stops.push((await tour.getAttribute('data-stop'))!);
    // Above the bottom bar, and inside the screen.
    const box = (await tour.boundingBox())!;
    const barBox = (await bar.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(barBox.y);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await page.getByTestId(i < 3 ? 'tour-next' : 'tour-done').click();
  }
  expect(stops).toEqual(['home', 'inbox', 'pipeline', 'calendar']);
  await expect(tour).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  // Again from Get help in the menu drawer, which closes so the tour can point at the bar.
  await page.getByTestId('mobile-menu').click();
  await page.getByTestId('get-help').filter({ visible: true }).click();
  await page.getByTestId('get-help-tour').click();
  await expect(tour).toHaveAttribute('data-stop', 'home');
  await expect(page.getByTestId('drawer-menu')).toBeHidden();
  await page.getByTestId('tour-skip').click();
  await expect(tour).toHaveCount(0);
});
