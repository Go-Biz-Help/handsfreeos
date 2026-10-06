import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * An agency's saved answers for quick setup (HANDSFREEOS_AI_QUICK_SETUP_IMPLEMENTATION_PLAN.md §9), with one agency
 * owner and two client businesses of the same kind:
 * 1. Pipes Plumbing goes through quick setup (Max, professional, asks qualifying questions, works when it's closed)
 *    and, on the test chat, saves its answers for the agency's other businesses.
 * 2. Drain Pros starts quick setup from them: picked by default on the first screen, so its teammate is Max and
 *    asks qualifying questions. Picking our picks instead picks those answers again.
 * 3. The agency area's AI setups page lists them; saving from a business without a teammate, or under a name
 *    already used, says why not; the others are renamed and removed.
 */
test('agency AI setups: saved from quick setup, started from in another business, renamed and removed', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { email } = await signUpAndConfirm(page, 'ai-setups');
  const pipes = await createBusiness(page, {
    name: 'Pipes Plumbing',
    agencyName: 'Setups Agency',
  });
  const { token } = await signInOwner(email);
  const me = await api<{ workspaces: { id: string; organizationId: string }[] }>(
    token,
    'queries',
    'account.me',
    {},
  );
  const orgId = me.workspaces.find((w) => w.id === pipes)!.organizationId;
  const { workspaceId: drains } = await api<{ workspaceId: string }>(
    token,
    'commands',
    'workspace.create',
    { organizationId: orgId, name: 'Drain Pros' },
  );

  const setup = page.getByTestId('ai-setup');
  const summary = page.getByTestId('ai-setup-summary');
  const next = page.getByTestId('ai-setup-next');
  const at = (step: string) => expect(setup).toHaveAttribute('data-step', step);

  // 1. Pipes Plumbing's quick setup, with nothing saved to start from yet.
  await page.goto(`/app/w/${pipes}/ai-team/setup`);
  await at('business');
  await expect(page.getByTestId('ai-setup-start-picks')).toHaveCount(0);
  await next.click();
  await at('jobs');
  await page.getByTestId('ai-setup-job-qualify').click();
  await next.click();
  await at('about');
  await page
    .getByTestId('ai-setup-description')
    .fill('We fix leaks, clear drains and put in water heaters across Austin.');
  await next.click();
  await at('hours');
  await page.getByTestId('ai-setup-answer-after_hours').click();
  await next.click();
  await at('facts');
  await next.click();
  await at('meet');
  await page.getByTestId('ai-setup-name').fill('Max');
  await next.click();
  await at('voice');
  await page.getByTestId('ai-setup-tone-professional').click();
  await next.click();
  await at('learned');
  await next.click();
  await at('qualify');
  await next.click();
  // No website, so no website chat to add: Save is on "Staying in the loop".
  await at('loop');
  await expect(next).toHaveText('Save');
  await next.click();
  await at('try');

  // Saved for the agency's other businesses, named after the kind of business unless renamed.
  await page.getByTestId('ai-setup-save-for-others').click();
  await expect(page.getByTestId('ai-setup-save-name')).toHaveValue('Home services');
  await page.getByTestId('ai-setup-save-name').fill('Plumbers');
  await page.getByTestId('ai-setup-save-for-others-save').click();
  await expect(page.getByTestId('ai-setup-saved-for-others')).toHaveText(
    'Saved as “Plumbers”. Your other businesses can start from it on quick setup’s first screen.',
  );
  const { items } = await api<{ items: { id: string; name: string }[] }>(
    token,
    'queries',
    'ai_setup_template.list',
    { organizationId: orgId },
  );
  const plumbers = items.find((t) => t.name === 'Plumbers')!.id;

  // 2. Drain Pros starts from them while nobody picks: the newest saved for its kind of business.
  await page.goto(`/app/w/${drains}/ai-team/setup`);
  await at('business');
  const saved = page.getByTestId(`ai-setup-start-${plumbers}`);
  const picks = page.getByTestId('ai-setup-start-picks');
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await expect(saved).toContainText(
    'Max · Professional · Replies to new leads, answers questions, asks qualifying questions, follows up',
  );
  await expect(picks).toHaveAttribute('aria-checked', 'false');
  await next.click();
  await at('jobs');
  await expect(page.getByTestId('ai-setup-job-qualify')).toHaveAttribute('aria-checked', 'true');
  await expect(summary).toContainText('Max replies to new leads within a minute.');
  await expect(summary).toContainText('It works when you’re closed');
  await next.click();
  await at('about');

  // Our picks instead, from the first screen: what the saved answers set is picked again.
  await page.getByTestId('ai-setup-back').click();
  await at('jobs');
  await page.getByTestId('ai-setup-back').click();
  await at('business');
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await picks.click();
  await expect(picks).toHaveAttribute('aria-checked', 'true');
  await expect(saved).toHaveAttribute('aria-checked', 'false');
  await next.click();
  await at('jobs');
  await expect(page.getByTestId('ai-setup-job-qualify')).toHaveAttribute('aria-checked', 'false');
  await expect(summary).toContainText('Ava replies to new leads within a minute.');
  await expect(summary).toContainText('It works all the time');
  // And it stays picked when the page is loaded again, which carries on after the furthest screen answered.
  await page.reload();
  await at('about');
  await expect(page.getByTestId('ai-setup-carry-on')).toBeVisible();
  await page.getByTestId('ai-setup-back').click();
  await at('jobs');
  await expect(page.getByTestId('ai-setup-job-qualify')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('ai-setup-back').click();
  await at('business');
  await expect(picks).toHaveAttribute('aria-checked', 'true');

  // 3. The agency area lists them, with the business they came from.
  await page.goto(`/app/org/${orgId}/ai-setups`);
  await expect(page.getByTestId('agency-nav-ai-setups')).toHaveAttribute('aria-current', 'page');
  const row = page.getByTestId(`ai-setup-row-${plumbers}`);
  await expect(row).toContainText('Plumbers');
  await expect(row).toContainText('Home services');
  await expect(row).toContainText('From Pipes Plumbing');

  // Saving from a business without a teammate, or under a name already used, says why not.
  await page.getByTestId('ai-setups-save').click();
  await page.getByTestId('ai-setups-business').selectOption(drains);
  await page.getByTestId('ai-setups-name').fill('Drains');
  await page.getByTestId('ai-setups-save-confirm').click();
  await expect(page.getByRole('dialog')).toContainText(
    'Drain Pros hasn’t set up its AI teammate yet, so there are no answers to save. Run quick setup there first.',
  );
  await page.getByTestId('ai-setups-business').selectOption(pipes);
  await page.getByTestId('ai-setups-name').fill('plumbers');
  await page.getByTestId('ai-setups-save-confirm').click();
  await expect(page.getByRole('dialog')).toContainText(
    'Your agency already has saved answers called “plumbers”.',
  );
  await page.getByTestId('ai-setups-name').fill('Plumbers, after hours');
  await page.getByTestId('ai-setups-save-confirm').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByTestId('ai-setups-list').locator('[data-testid^="ai-setup-row-"]'),
  ).toHaveCount(2);

  // Renamed, then removed: removing them changes no business.
  await page.getByTestId(`ai-setup-rename-${plumbers}`).click();
  await page.getByTestId('ai-setups-rename-name').fill('Plumbing shops');
  await page.getByTestId('ai-setups-rename-confirm').click();
  await expect(row).toContainText('Plumbing shops');
  await page.getByTestId(`ai-setup-remove-${plumbers}`).click();
  await page.getByTestId('ai-setups-remove-confirm').click();
  await expect(row).toHaveCount(0);
  const other = page.getByTestId('ai-setups-list').locator('[data-testid^="ai-setup-row-"]');
  await expect(other).toHaveCount(1);
  await other.locator('[data-testid^="ai-setup-remove-"]').click();
  await page.getByTestId('ai-setups-remove-confirm').click();
  await expect(page.getByTestId('ai-setups-empty')).toBeVisible();
  const teammate = await api<{ teammate: { config: { identity: { name: string } } } | null }>(
    token,
    'queries',
    'ai_teammate.get',
    { workspaceId: pipes },
  );
  expect(teammate.teammate?.config.identity.name).toBe('Max');
});
