import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

test.use({ colorScheme: 'dark' });

/**
 * The AI teammate on a 390 px phone, in the dark theme: it's in the drawer (the bar stays at five), the
 * picker fits, the builder's rail folds into a card at the top, each module opens full screen and saves
 * from there, the status and checks open in a sheet, and the test console fills the screen.
 *
 * Quiet hours are set explicitly (8 PM to 8 AM) so nothing depends on the default.
 */
test('AI teammate at 390 px, dark: drawer, picker, modules full screen, checks and test console', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { email } = await signUpAndConfirm(page, 'ai-team-mobile');
  const workspaceId = await createBusiness(page, { name: 'Bayou Plumbing Co.' });
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });
  const width = () => page.evaluate(() => document.documentElement.scrollWidth);

  // The dark theme's tokens.
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    ),
  ).toBe('#0f131a');

  // The bar stays at five; the AI teammate is in the drawer.
  const bar = page.getByRole('navigation', { name: 'Primary' });
  await expect(bar.getByRole('link')).toHaveText(['Home', 'Inbox', 'Pipeline', 'Calendar']);
  await bar.getByRole('button', { name: 'More' }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'AI teammate' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/ai-team$`));
  const picker = page.getByTestId('teammate-preset-picker');
  await expect(picker).toBeVisible();
  expect((await picker.boundingBox())!.width).toBeLessThanOrEqual(390);
  expect(await width()).toBeLessThanOrEqual(390);

  await page.getByTestId('teammate-preset-appointment_coordinator').click();
  await page.getByTestId('teammate-name-input').fill('Riley');
  await page.getByTestId('teammate-create').click();

  // The rail folds into the card at the top; the modules are a list.
  const summary = page.getByTestId('teammate-phone-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Riley');
  await expect(page.getByTestId('teammate-status-phone')).toHaveText('Off');
  await expect(page.getByTestId('phone-module-followUp')).toContainText('Off');
  expect(await width()).toBeLessThanOrEqual(390);

  // A module opens full screen, and saves from its top bar.
  await page.getByTestId('phone-module-followUp').click();
  const screen = page.getByTestId('teammate-module-screen');
  await expect(screen).toBeVisible();
  const box = (await screen.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  expect(box.height).toBeGreaterThan(800);
  await screen.getByTestId('skill-followUp').click();
  await screen.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/^Saved as revision 2\./)).toBeVisible();
  await expect(screen.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await screen.getByRole('button', { name: 'Back' }).click();
  await expect(screen).toBeHidden();
  await expect(page.getByTestId('phone-module-followUp')).toContainText('Up to 2 nudges');

  // The status, labels and things to check open in a sheet.
  await page.getByTestId('teammate-phone-checks').click();
  const sheet = page.getByTestId('teammate-phone-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('teammate-status-card')).toContainText('Training wheels');
  await expect(sheet).toContainText('Things to check');
  await expect(sheet.getByTestId('teammate-labels')).toContainText('Appointment Coordinator');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // The test console fills the screen, and says when it isn't there yet.
  await summary.getByRole('button', { name: 'Test console' }).click();
  const testConsole = page.getByTestId('test-console');
  await expect(testConsole).toBeVisible();
  const full = (await testConsole.boundingBox())!;
  expect(full.width).toBeLessThanOrEqual(390);
  expect(full.height).toBeGreaterThan(800);
  await testConsole.getByTestId('test-console-input').fill('Can I book for Thursday morning?');
  await testConsole.getByTestId('test-console-send').click();
  await expect(testConsole.getByTestId('test-console-missing')).toBeVisible();
  await testConsole.getByRole('button', { name: 'Close' }).click();
  await expect(testConsole).toBeHidden();

  // Activity fits the phone too.
  await page.getByTestId('subnav-activity').click();
  await expect(page.getByTestId('teammate-activity')).toBeVisible();
  expect(await width()).toBeLessThanOrEqual(390);
});
