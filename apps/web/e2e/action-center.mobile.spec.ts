import { expect, test } from '@playwright/test';
import {
  actionCenterOwner,
  addLead,
  cardOf,
  itemsFor,
  pageWidth,
  sweep,
  twoDaysAgo,
} from './action-center-helpers';
import { api } from './booking-helpers';

/**
 * Home on a 390 × 844 phone, in light and dark: the header is a band with "$ affected" and the Mine / Everyone
 * switch full width under it; cards go full width with 44 px buttons; Today folds below the list and opens in
 * place; nothing scrolls sideways. ⋯ opens a bottom sheet with Snooze first (52 px rows), and a snooze from it
 * can be undone. Let HandsFreeOS Handle opens as a bottom sheet that fits the screen.
 */
test('on a phone: the Action Center in light and dark', async ({ page }) => {
  test.setTimeout(180_000);
  const o = await actionCenterOwner(page, 'ac-phone');
  await addLead(o, 'Maria', 'Lopez', 'New AC install', 1_850_000);
  await addLead(o, 'Carlos', 'Mendoza', 'Roof leak repair', 420_000);
  await api(o.token, 'commands', 'task.create', {
    workspaceId: o.workspaceId,
    title: 'Call Mike about the roof estimate',
    dueAt: twoDaysAgo(),
    allDay: true,
  });
  // The task is already overdue: a sweep opens its item without waiting for the hourly one.
  await sweep(o.workspaceId);
  await itemsFor(o, ['New AC install', 'Roof leak repair', 'Call Mike about the roof estimate']);

  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/app/w/${o.workspaceId}`);
    // The band across the top: the numbers, then the switch full width.
    const header = page.getByTestId('attention-header');
    await expect(page.getByTestId('attention-affected')).toHaveText('$22,700 affected');
    await expect(page.getByTestId('attention-counts')).toContainText('3 need attention');
    const band = (await header.boundingBox())!;
    expect(band.x).toBeLessThanOrEqual(0.5);
    expect(Math.round(band.width)).toBe(390);
    const everyone = (await page.getByTestId('scope-everyone').boundingBox())!;
    expect(everyone.height).toBeGreaterThanOrEqual(34);

    // Full-width cards with 44 px buttons.
    const maria = cardOf(page, 'Maria Lopez');
    const card = (await maria.boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(12);
    expect(card.x + card.width).toBeLessThanOrEqual(378);
    const handle = (await maria.getByTestId('attention-handle').boundingBox())!;
    expect(handle.height).toBeGreaterThanOrEqual(44);
    expect(handle.width).toBeGreaterThan(card.width - 40);
    expect(
      (await maria.getByTestId('attention-let-handle').boundingBox())!.height,
    ).toBeGreaterThanOrEqual(44);
    const more = (await maria.getByTestId('attention-more').boundingBox())!;
    expect(more.height).toBeGreaterThanOrEqual(44);
    expect(more.width).toBeGreaterThanOrEqual(44);
    // The task's card: its main button opens it.
    await expect(cardOf(page, 'Call Mike about the roof estimate')).toContainText('Overdue task');
    // The theme reaches the cards.
    expect(await maria.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      scheme === 'dark' ? 'rgb(25, 29, 37)' : 'rgb(255, 255, 255)',
    );

    // Today folds below the list (the side rail's card isn't shown on a phone), and opens in place.
    await expect(page.getByTestId('today-card')).toBeHidden();
    await expect(page.getByTestId('today-fold-body')).toHaveCount(0);
    await page.getByTestId('today-fold').getByRole('button').click();
    await expect(page.getByTestId('today-fold-body')).toBeVisible();
    await expect(page.getByTestId('coming-up-fold')).toContainText('Coming up from HandsFreeOS');
    expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  }

  // ⋯ opens a bottom sheet: Snooze first, in 52 px rows. Snoozed, then undone.
  const carlos = cardOf(page, 'Carlos Mendoza');
  await carlos.getByTestId('attention-more').click();
  const sheet = page.getByTestId('attention-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Assign…');
  const tomorrow = sheet.getByTestId('snooze-tomorrow');
  expect((await tomorrow.boundingBox())!.height).toBeGreaterThanOrEqual(52);
  await tomorrow.click();
  await expect(carlos).toHaveCount(0);
  await expect(page.getByText('Snoozed until tomorrow at 8:00 AM')).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(carlos).toBeVisible();

  // Let HandsFreeOS Handle comes up from the bottom, inside the screen.
  await carlos.getByTestId('attention-let-handle').click();
  const handle = page.getByTestId('let-handle-sheet');
  await expect(handle).toContainText('Asks first');
  const box = (await handle.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  await handle.getByRole('button', { name: 'Cancel' }).click();
  await expect(handle).toHaveCount(0);
});
