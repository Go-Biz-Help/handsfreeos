import { expect, test } from '@playwright/test';
import { addTeammate } from './calendar';
import { createBusiness, signUpAndConfirm } from './helpers';
import { setUpTexting } from './telephony';

/**
 * Search settings (design/search/Settings.dc.html, board 6): the box at the top of the Settings menu finds settings
 * from core's catalogue as you type, grouped as the menu is, with the count core works out (never the board's
 * example); choosing one opens its page at it and rings it, on another page or the one you're on, and an Adjust field
 * opens its sheet every time; Show every setting brings the menu back; and a member finds only what their menu holds.
 */
test('“quiet” finds Quiet hours, and choosing it rings the row, on its page or the one you’re on', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'settings-search');
  const business = 'Quiet Hours Plumbing';
  const workspaceId = await createBusiness(page, { name: business });
  // Quiet hours is a row of Texting rules, which shows once the business number is working.
  await setUpTexting(page, workspaceId);

  await page.goto(`/app/w/${workspaceId}/settings`);
  const nav = page.getByTestId('settings-nav');
  await nav.getByTestId('settings-search-input').fill('quiet');
  // The count core works out from its own catalogue, as the box does.
  const { ROLE_PERMISSIONS, searchSettings, settingsCount, settingsFound } =
    await import('@hfos/core');
  const found = settingsCount(
    searchSettings('quiet', { permissions: ROLE_PERMISSIONS.owner, addons: [], surface: 'web' }),
  );
  await expect(nav.getByTestId('settings-search-count')).toHaveText(
    settingsFound(found.settings, found.pages),
  );
  await expect(nav.getByTestId('settings-search-page-texting')).toContainText('Texting & calls');
  await expect(nav.getByTestId('settings-search-page-automations')).toContainText('Automations');
  const quiet = nav.getByTestId('settings-search-hit-texting.quiet_hours');
  await expect(quiet).toContainText('Quiet hours');
  await expect(quiet).toContainText('Texting rules');
  await expect(nav.getByTestId('settings-search-hit-adjust.gone_quiet')).toContainText(
    'Gone quiet after',
  );

  await quiet.click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/texting#quiet-hours$`));
  const row = page.locator('#quiet-hours');
  await expect(row).toHaveAttribute('data-setting', 'texting.quiet_hours');
  await expect(row).toHaveClass(/ring-2/);
  await expect(row).not.toHaveClass(/ring-2/, { timeout: 10_000 });

  // Already on the page, the jump rings it again: a push to the same page fires no hashchange.
  await quiet.click();
  await expect(row).toHaveClass(/ring-2/);

  // ↓ moves over the rows, the page first and then its settings, and ↵ opens the one picked.
  const box = nav.getByTestId('settings-search-input');
  await box.fill('time zone');
  await box.press('ArrowDown');
  await box.press('ArrowDown');
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/settings/workspace#workspace-time-zone$`));
  await expect(page.locator('#workspace-time-zone')).toHaveClass(/ring-2/);
  // ↵ with nothing picked opens the best match, not the first page in the menu; Esc clears the search.
  await box.fill('quiet hours');
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/settings/texting#quiet-hours$`));
  await expect(row).toHaveClass(/ring-2/);
  await box.press('Escape');
  await expect(nav.getByRole('navigation', { name: 'Settings' })).toBeVisible();

  // An Adjust field opens its automation's sheet with the field ringed, from the Automations page itself, and again
  // after the sheet was closed, for another field of the same automation.
  await page.goto(`/app/w/${workspaceId}/settings/automations`);
  await box.fill('big job');
  await nav.getByTestId('settings-search-hit-adjust.big_job').click();
  await expect(page).toHaveURL(/\/settings\/automations\?adjust=hot_lead_alert#adjust-big-job$/);
  await expect(page.getByRole('dialog').locator('#adjust-big-job')).toHaveClass(/ring-2/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await box.fill('urgent after');
  await nav.getByTestId('settings-search-hit-adjust.urgent_after').click();
  await expect(page.getByRole('dialog').locator('#adjust-urgent-after')).toHaveClass(/ring-2/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Show every setting brings the menu back too.
  await box.fill('quiet');
  await nav.getByTestId('settings-search-show-all').click();
  await expect(box).toHaveValue('');
  await expect(nav.getByRole('navigation', { name: 'Settings' })).toBeVisible();

  // A member may change neither texting nor automations: nothing for “quiet”, and no Texting & calls.
  const member = await addTeammate(page, browser, workspaceId, business);
  await member.page.goto(`/app/w/${workspaceId}/settings`);
  const theirs = member.page.getByTestId('settings-nav');
  await theirs.getByTestId('settings-search-input').fill('quiet');
  await expect(theirs.getByTestId('settings-search-none')).toContainText(
    'No settings match “quiet”.',
  );
  await theirs.getByTestId('settings-search-input').fill('texting');
  await expect(theirs.getByTestId('settings-search-page-texting')).toHaveCount(0);
  // Their own account is theirs to search.
  await theirs.getByTestId('settings-search-input').fill('appearance');
  await expect(theirs.getByTestId('settings-search-hit-account.appearance')).toBeVisible();
  await member.context.close();
});
