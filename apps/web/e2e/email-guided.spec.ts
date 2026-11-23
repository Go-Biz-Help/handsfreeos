import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

const card = (page: Page) => page.getByTestId('email-guided');
const next = (page: Page) => page.getByTestId('email-guided-next').click();

/**
 * The guided email setup (the owner, 22 Nov 2026), the way Burroughs Digital would have walked it: the website
 * name's mail goes somewhere else today (the local mail service says any oldmx-… name is looked after at SiteGround,
 * with two old mail records). One question at a time, the answers saved as they're given, nothing changed until
 * Set it up; then the last step's records, and Done once they're found.
 */
test('guided email setup: the questions, Set it up, the last step and Done', async ({ page }) => {
  test.setTimeout(300_000);
  await signUpAndConfirm(page, 'email-guided');
  const workspaceId = await createBusiness(page, { name: 'Burroughs Digital' });
  const domain = `oldmx-${Date.now().toString(36)}.com`;

  // Settings → Email offers it while the business has no website name of its own.
  await page.goto(`/app/w/${workspaceId}/settings/email`);
  await page.getByTestId('email-guided-open').click();
  await expect(page).toHaveURL(/\/onboarding\/[^/]+\/email\?from=settings/);

  // 1. Which email: its own website name, looked up while it's typed.
  await expect(card(page)).toHaveAttribute('data-screen', 'which');
  await page.getByTestId('email-guided-own').click();
  await page.getByTestId('email-guided-domain').fill(domain);
  await expect(page.getByTestId('email-guided-found')).toContainText('SiteGround', {
    timeout: 30_000,
  });
  await next(page);

  // 2. Which addresses: one for the team and one of my own, whatever it suggested to start with.
  await expect(card(page)).toHaveAttribute('data-screen', 'addresses');
  while (await page.getByTestId('email-guided-remove-1').count())
    await page.getByTestId('email-guided-remove-1').click();
  if (!(await page.getByTestId('email-guided-address-0').count()))
    await page.getByTestId('email-guided-add').click();
  await page.getByTestId('email-guided-address-0').fill('office');
  await page.getByTestId('email-guided-add').click();
  await page.getByTestId('email-guided-address-1').fill('dale');
  await next(page);

  // 3. Who reads each one. The answers are saved by now: leaving and coming back lands on this same question.
  await expect(card(page)).toHaveAttribute('data-screen', 'readers');
  await page.getByTestId('email-guided-reader-office-team').click();
  await page.getByTestId('email-guided-reader-dale-me').click();
  await expect(page.getByTestId('guided-saved')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(card(page)).toHaveAttribute('data-screen', 'readers');
  await expect(page.getByTestId('email-guided-reader-dale-me')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByTestId('email-guided-reader-office-team')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await next(page);

  // 4. The one customers hear from: only an address the team reads can be it.
  await expect(card(page)).toHaveAttribute('data-screen', 'sender');
  await expect(page.getByTestId('email-guided-sender-office')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await next(page);

  // 5. Where the mail arrives: it goes somewhere today, so that is the person's to pick, never ours.
  await expect(card(page)).toHaveAttribute('data-screen', 'receive');
  await expect(card(page)).toContainText('SiteGround');
  await page.getByTestId('email-guided-receive-here').click();
  await expect(page.getByTestId('email-guided-old-stays')).toBeVisible();
  await next(page);

  // Check it over: nothing has changed yet.
  await expect(card(page)).toHaveAttribute('data-screen', 'review');
  await expect(card(page)).toContainText(`office@${domain}`);
  await expect(card(page)).toContainText(`dale@${domain}`);
  await next(page);

  // The last step: the records to add, as the worker gets them from the mail service.
  await expect(page).toHaveURL(/at=records/, { timeout: 30_000 });
  await expect(page.getByTestId('email-guided-record-txt').first()).toBeVisible({
    timeout: 30_000,
  });
  // The (local) mail service finds its records on a check; then the mail record, and the old ones gone.
  await expect(async () => {
    const check = page.getByTestId('email-guided-check');
    if (await check.isVisible()) await check.click();
    await expect(page.getByTestId('email-guided-done')).toBeVisible({ timeout: 5000 });
  }).toPass({ timeout: 120_000 });

  // Done: each address with who reads it.
  const done = page.getByTestId('email-guided-done');
  await expect(done).toContainText(`office@${domain}`);
  await expect(done).toContainText(`dale@${domain}`);
  await expect(done).toContainText('Only you read it');

  // Back in Settings → Email, it is all there to change, and the questions can be run again.
  await page.getByTestId('email-guided-to-settings').click();
  await expect(page).toHaveURL(/\/settings\/email/);
  await expect(page.getByTestId('email-address-office')).toContainText(
    'Customers hear from this one',
  );
  await expect(page.getByTestId('email-address-dale')).toContainText('Only you read it');
  await expect(page.getByTestId('domain-name')).toHaveText(domain);
  await expect(page.getByTestId('domain-receiving')).toContainText('Lands in HandsFreeOS');
  await expect(page.getByTestId('domain-records')).toContainText('found');
  await page.getByTestId('email-guided-again').click();
  await expect(card(page)).toHaveAttribute('data-screen', 'which');
});
