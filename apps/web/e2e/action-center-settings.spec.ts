import { expect, test, type Page } from '@playwright/test';
import { api, ownerWithSite, type Owner } from './booking-helpers';

/**
 * Settings → Action Center (design/m8 Settings): in the nav after Website chat; the kinds' switches and thresholds
 * save as they're changed; the follow-up wording's live preview and its problems in plain words (a price, a link,
 * a carrier keyword, double braces); follow-ups stay off until an owner reads the wording and chooses “Looks good,
 * turn on”; and Reply C to confirm. Every change is checked in the saved settings.
 */

type Attention = {
  kinds: Record<string, boolean>;
  hot: { urgentAfterMinutes: number; minValueCents: number };
  stale: { days: number; stageDays: Record<string, number> };
  typicalJobValueCents: number | null;
  auto: { confirmRequests: boolean; nudges: boolean; nudgeReviewedAt: string | null };
  nudge: { template: string };
  replyToConfirm: boolean;
};

/** The saved Action Center settings (`workspaces.settings.attention`), or {} before the first save. */
async function saved(owner: Owner): Promise<Partial<Attention>> {
  const { workspace } = await api<{ workspace: { settings: { attention?: Attention } } }>(
    owner.token,
    'queries',
    'workspace.get',
    { workspaceId: owner.workspaceId },
  );
  return workspace.settings.attention ?? {};
}

/** Types into a box and leaves it, which saves it. */
async function enter(page: Page, testId: string, value: string) {
  const box = page.getByTestId(testId);
  await box.fill(value);
  await box.press('Enter');
}

test('Action Center settings: switches, the wording’s preview and problems, and Looks good, turn on', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'ac-settings', 'Lone Star Settings HVAC');
  // Open hours and quiet hours set explicitly: nothing here sends, but no spec leans on the defaults (a business
  // is open weekdays 8 to 5 until it says otherwise).
  await api(owner.token, 'commands', 'workspace.update', {
    workspaceId: owner.workspaceId,
    settings: {
      openHours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' })),
    },
  });
  await api(owner.token, 'commands', 'phone.update_settings', {
    workspaceId: owner.workspaceId,
    quietHours: { enabled: true, start: '20:00', end: '08:00' },
  });

  // In the Settings nav, after Website chat.
  await page.goto(`/app/w/${owner.workspaceId}/settings`);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  const tabs = await nav.getByRole('link').allTextContents();
  expect(tabs.indexOf('Action Center')).toBe(tabs.indexOf('Website chat') + 1);
  await nav.getByRole('link', { name: 'Action Center' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${owner.workspaceId}/settings/action-center$`));
  await expect(page.getByTestId('action-center-settings')).toBeVisible();

  // A kind off and on again, saved each time.
  const hot = page.getByTestId('ac-kind-switch-hot_lead');
  await expect(hot).toHaveAttribute('aria-checked', 'true');
  await hot.click();
  await expect(page.getByText('HandsFreeOS stops looking for hot leads.')).toBeVisible();
  await expect.poll(async () => (await saved(owner)).kinds?.hot_lead).toBe(false);
  // Its threshold waits while it's off.
  await expect(page.getByTestId('ac-threshold-hot_lead')).toBeDisabled();
  await hot.click();
  await expect(hot).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await saved(owner)).kinds?.hot_lead).toBe(true);
  // Approvals are always on.
  await expect(page.getByTestId('ac-kind-switch-ai_approval')).toBeDisabled();
  await expect(page.getByTestId('ac-kind-ai_approval')).toContainText('Always on');

  // A threshold saves when it's left; one out of range goes back.
  await enter(page, 'ac-threshold-hot_lead', '20');
  await expect(page.getByText('A hot lead is urgent after 20 min.')).toBeVisible();
  await expect.poll(async () => (await saved(owner)).hot?.urgentAfterMinutes).toBe(20);
  await enter(page, 'ac-threshold-hot_lead', '999');
  await expect(page.getByText('Use a whole number from 1 to 240.')).toBeVisible();
  await expect(page.getByTestId('ac-threshold-hot_lead')).toHaveValue('20');

  // The typical job value, and a stage that goes quiet sooner.
  await enter(page, 'ac-typical-value', '4200');
  await expect(page.getByTestId('ac-typical-value')).toHaveValue('$4,200');
  await expect.poll(async () => (await saved(owner)).typicalJobValueCents).toBe(420_000);
  const stage = page.locator('[data-testid^="ac-stale-"]').first();
  const stageId = (await stage.getAttribute('data-testid'))!.replace('ac-stale-', '');
  await stage.fill('3');
  await stage.press('Enter');
  await expect.poll(async () => (await saved(owner)).stale?.stageDays?.[stageId]).toBe(3);

  // Follow-ups are off until an owner reads the wording: the switch alone won't turn them on.
  const nudges = page.getByTestId('ac-nudge-switch');
  await expect(page.getByTestId('ac-nudge-badge')).toHaveText(
    'Off until an owner reads the wording',
  );
  await nudges.click();
  await expect(
    page.getByText('Read the wording first, then use Looks good, turn on.'),
  ).toBeVisible();
  await expect(nudges).toHaveAttribute('aria-checked', 'false');

  // The preview fills in a sample customer as it's typed.
  const box = page.getByTestId('ac-template');
  const preview = page.getByTestId('ac-preview');
  await expect(preview).toContainText('Hi Maria, it');
  await expect(preview).toContainText('at Lone Star Settings HVAC.');
  await expect(page.getByTestId('ac-check-length')).toContainText(/\d+ characters · 1 text/);
  await box.fill('Hi {firstName}, checking in on your');
  await box.press('End');
  await page.getByTestId('ac-insert-leadTitle').click();
  await expect(box).toHaveValue('Hi {firstName}, checking in on your {leadTitle}');
  await expect(preview).toHaveText('Hi Maria, checking in on your AC replacement');

  // Problems in plain words: a price and a link, then a carrier keyword and double braces.
  await box.fill('Hi {firstName}, the new unit is $4,500. Book at https://deals.example.com/ac');
  await expect(page.getByTestId('ac-check-money')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('ac-check-link')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('ac-problems')).toBeVisible();
  await expect(page.getByTestId('ac-look-good')).toBeDisabled();
  await box.fill('Hi {{firstName}}, reply CANCEL if you’re no longer interested.');
  await expect(page.getByTestId('ac-problems')).toContainText(
    'Use single braces: {firstName}, not {{firstName}}.',
  );
  await expect(page.getByTestId('ac-problems')).toContainText('Don’t ask them to reply CANCEL');
  // A wording with problems isn't saved when it's left.
  await box.blur();
  await expect.poll(async () => (await saved(owner)).nudge?.template ?? '').not.toContain('CANCEL');

  // Reset puts the original back, with nothing to fix.
  await page.getByTestId('ac-reset').click();
  await expect(page.getByTestId('ac-problems')).toHaveCount(0);
  await expect(page.getByTestId('ac-check-money')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('ac-check-link')).toHaveAttribute('data-ok', 'true');

  // “Looks good, turn on”: follow-ups are on, and the review is recorded.
  await page.getByTestId('ac-look-good').click();
  await expect(page.getByTestId('ac-nudge-on')).toHaveText('On');
  await expect(nudges).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ac-nudge-badge')).toHaveCount(0);
  await expect
    .poll(async () => {
      const s = await saved(owner);
      return [s.auto?.nudges, !!s.auto?.nudgeReviewedAt];
    })
    .toEqual([true, true]);
  // Once read, the switch turns them off and on.
  await nudges.click();
  await expect(page.getByText('Follow-ups are off. Nothing waiting will go.')).toBeVisible();
  await expect.poll(async () => (await saved(owner)).auto?.nudges).toBe(false);
  await nudges.click();
  await expect.poll(async () => (await saved(owner)).auto?.nudges).toBe(true);

  // Reply C to confirm: the reminder's sample loses its last line, and it's saved.
  const replyC = page.getByTestId('ac-replyc-preview');
  await expect(replyC).toContainText('Reply C to confirm.');
  await page.getByTestId('ac-replyc-switch').click();
  await expect(replyC).not.toContainText('Reply C to confirm.');
  await expect.poll(async () => (await saved(owner)).replyToConfirm).toBe(false);

  // Everything is still there after a reload.
  await page.reload();
  await expect(page.getByTestId('ac-nudge-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('ac-replyc-switch')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('ac-threshold-hot_lead')).toHaveValue('20');
  await expect(page.getByTestId(`ac-stale-${stageId}`)).toHaveValue('3');
});
