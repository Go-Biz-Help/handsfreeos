import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import {
  confirmEmail,
  createBusiness,
  linkFrom,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';

/**
 * A teammate's Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §3, §6): joining shows the tour
 * once; Home has "Get set up", their own four rows and none of the business's; each row opens the page that does
 * it; with every row skipped, "You're set up" once, then Get help is only the form again.
 */
test('a teammate gets set up: their own four steps, the tour, then done', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'guide-mate-owner');
  const workspaceId = await createBusiness(page, { name: 'Guide Team Plumbing' });
  const { token } = await signInOwner(email);

  const mate = uniqueEmail('guide-mate');
  const started = Date.now();
  await api(token, 'commands', 'membership.invite', { workspaceId, email: mate, role: 'member' });
  const mail = await waitForMail(mate, 'invited you to Guide Team Plumbing', { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const mem = await ctx.newPage();
  await signUp(mem, { name: 'Priya Natarajan', email: mate });
  await confirmEmail(mem, mate);
  await mem.goto(link);
  await mem.getByTestId('accept-invite').click();

  // Joining lands on Home with the tour.
  await expect(mem).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));
  const tour = mem.getByTestId('tour');
  await expect(tour).toHaveAttribute('data-stop', 'home');
  await mem.getByTestId('tour-skip').click();
  await expect(tour).toHaveCount(0);

  // Their own list: four rows, none of the business's.
  const guide = mem.getByTestId('getting-started');
  await expect(guide.getByRole('heading', { name: 'Get set up' })).toBeVisible();
  await expect(mem.getByTestId('getting-started-count')).toHaveText('0 of 4 done');
  const rows = guide.locator('li[data-state]');
  await expect(rows).toHaveCount(4);
  for (const key of ['app', 'notifications', 'my_calendar', 'sign_in'])
    await expect(mem.getByTestId(`getting-started-${key}`)).toBeVisible();
  await expect(mem.getByTestId('getting-started-number')).toHaveCount(0);
  await expect(mem.getByTestId('getting-started-questions')).toHaveCount(0);
  await expect(mem.getByTestId('getting-started-tour')).toHaveCount(0);

  // Each row opens what does it.
  await expect(
    mem.getByTestId('getting-started-sign_in').getByRole('link', { name: 'Set up' }),
  ).toHaveAttribute('href', /\/settings#(passkeys|google)$/);
  await mem
    .getByTestId('getting-started-my_calendar')
    .getByRole('link', { name: 'Connect' })
    .click();
  // The dev server builds a page the first time it's opened, which takes a while.
  await expect(mem).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/my-calendar$`), {
    timeout: 60_000,
  });
  await mem.goto(`/app/w/${workspaceId}`);

  // Skip every row: "You're set up" names what was skipped, once, and Done puts it away for good.
  for (const key of ['app', 'notifications', 'my_calendar', 'sign_in']) {
    const row = mem.getByTestId(`getting-started-${key}`);
    await row.getByRole('button', { name: 'Skip' }).click();
    if (key !== 'sign_in') await expect(row).toHaveAttribute('data-state', 'skipped');
  }
  const done = mem.getByTestId('getting-started-done');
  await expect(done).toContainText('You’re set up');
  await expect(done).toContainText('Get the phone app');
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(done).toHaveCount(0);
  await expect(guide).toHaveCount(0);

  // Finished, Get help opens the form straight away, as it always did.
  await mem.getByTestId('get-help').click();
  await expect(mem.getByRole('dialog', { name: 'Ask us for help' })).toBeVisible();
  await ctx.close();
});
