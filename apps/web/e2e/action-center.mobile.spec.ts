import { expect, test } from '@playwright/test';
import {
  actionCenterOwner,
  addLead,
  attentionList,
  cardOf,
  itemsFor,
  pageWidth,
  sweep,
  twoDaysAgo,
} from './action-center-helpers';
import { api } from './booking-helpers';
import { setUpTexting, textFromCustomer } from './telephony';

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
    // The switch takes its phone size once the page is running in the browser (the server can't know the screen),
    // so wait for it rather than measuring the first paint.
    await expect
      .poll(async () => (await page.getByTestId('scope-everyone').boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(34);

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

/**
 * The Action Center's other screens on a 390 × 844 phone: Settings → Automations in one column, and its stale
 * leads sheet with the wording box and its live preview, the lead page's banner with 44 px buttons, and the inbox header's waiting chip.
 * Home has its own test above; these three had none.
 */
test('on a phone: Automations settings, the lead banner and the inbox chip', async ({ page }) => {
  test.setTimeout(240_000);
  const o = await actionCenterOwner(page, 'ac-phone-2');
  const tom = await addLead(o, 'Tom', 'Reyes', 'Rooftop unit replacement', 1_240_000);
  await sweep(o.workspaceId);
  await itemsFor(o, ['Rooftop unit replacement']);

  // Settings → Automations: one column, nothing sideways, and the follow-up wording off until it's read.
  await page.goto(`/app/w/${o.workspaceId}/settings/automations`);
  const settings = page.getByTestId('automations-settings');
  await expect(settings).toBeVisible();
  const panel = (await settings.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(0);
  expect(panel.x + panel.width).toBeLessThanOrEqual(390);
  // Each automation is a row you can hit with a thumb.
  expect(
    (await page.getByTestId('automation-hot_lead_alert').boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
  // Adjust opens as a sheet from the bottom, with the wording inside.
  await page.getByTestId('adjust-open-stale_opportunities').click();
  await expect(page.getByTestId('ac-nudge-badge')).toContainText(/Off until an owner/);
  const template = page.getByTestId('ac-template');
  const box = (await template.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId('ac-preview')).toBeVisible();
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);

  // The lead page's banner: full width inside the gutters, with 44 px Handle and ⋯.
  await page.goto(`/app/w/${o.workspaceId}/leads/${tom.leadId}`);
  const banner = page.getByTestId('attention-banner');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  const bar = (await banner.boundingBox())!;
  expect(bar.x).toBeGreaterThanOrEqual(0);
  expect(bar.x + bar.width).toBeLessThanOrEqual(390);
  expect(
    (await banner.getByTestId('attention-banner-handle').boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  expect(
    (await banner.getByTestId('attention-banner-more').boundingBox())!.height,
  ).toBeGreaterThanOrEqual(44);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);

  // The inbox header's waiting chip: the phone header's own, with a reply time of zero so it opens at once.
  const number = await setUpTexting(page, o.workspaceId);
  await api(o.token, 'commands', 'phone.update_settings', {
    workspaceId: o.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
    unansweredReminderMinutes: 0,
  });
  const from = `+1713555${String(Math.floor(Math.random() * 9000) + 1000)}`;
  await textFromCustomer({ from, to: number, body: 'Hi, I have a question about my bill.' });
  const waitingIn = async () =>
    (await attentionList(o)).items.find((i) => i.kind === 'customer_waiting')?.conversationId ??
    null;
  await expect.poll(waitingIn, { timeout: 60_000 }).not.toBeNull();
  await page.goto(`/app/w/${o.workspaceId}/inbox/${(await waitingIn())!}`);
  const chip = page.locator('[data-testid="attention-chip"]:visible').first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute('data-kind', 'customer_waiting');
  await expect(chip).toHaveAttribute('href', `/app/w/${o.workspaceId}`);
  expect(await pageWidth(page)).toBeLessThanOrEqual(390);
});
