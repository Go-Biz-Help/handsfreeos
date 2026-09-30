import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * An agency's view of its clients' setup (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6, board 11): Client
 * businesses has a Setup column and All / Stuck / Setting up / Done; a business's Setup opens its steps beside the
 * list, each still to do with "Do it for them" at the client's own screen, and the reminder to its own owners.
 */
test('an agency sees each client business’s setup, and does a step for them', async ({ page }) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'agency-setup');
  const first = await createBusiness(page, { name: 'Setup Lone Star', agencyName: 'Setup Agency' });
  const { token } = await signInOwner(email);
  const me = await api<{ workspaces: { id: string; organizationId: string }[] }>(
    token,
    'queries',
    'account.me',
    {},
  );
  const orgId = me.workspaces.find((w) => w.id === first)!.organizationId;
  const second = await api<{ workspaceId: string }>(token, 'commands', 'workspace.create', {
    organizationId: orgId,
    name: 'Setup Bayou Plumbing',
  });

  await page.goto(`/app/org/${orgId}/businesses`);
  await expect(
    page.getByText('2 businesses · 0 stuck on setup · 2 still setting up'),
  ).toBeVisible();
  const cell = page.getByTestId(`setup-${second.workspaceId}`);
  await expect(cell).toHaveAttribute('data-group', 'setup');
  await expect(cell).toContainText('0 of');
  await expect(cell).toContainText('Next: Business number & texting');

  // The filters narrow the list.
  await page.getByTestId('setup-filter-stuck').click();
  await expect(page.getByTestId(`business-row-${second.workspaceId}`)).toHaveCount(0);
  await expect(page.getByText('No businesses here right now.')).toBeVisible();
  await page.getByTestId('setup-filter-setup').click();
  await expect(page.getByTestId(`business-row-${second.workspaceId}`)).toBeVisible();

  // Its steps beside the list: do one for them at the client's own screen; payments is the owner's.
  await cell.click();
  const sheet = page.getByTestId('setup-sheet');
  await expect(sheet.getByTestId('setup-step-number')).toHaveAttribute('data-state', 'todo');
  await expect(sheet.getByTestId('setup-step-payments')).toContainText(
    'The owner signs in to Stripe or Square',
  );
  await expect(sheet.getByTestId('setup-do-payments')).toHaveCount(0);
  // Nobody owns it but the agency, so there's nobody to remind.
  await expect(sheet.getByTestId('setup-remind')).toBeDisabled();
  await expect(sheet).toContainText('Nobody owns Setup Bayou Plumbing yet apart from your agency');
  await sheet.getByTestId('setup-do-number').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${second.workspaceId}/setup/number$`), {
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: 'Get your business number' })).toBeVisible();
});
