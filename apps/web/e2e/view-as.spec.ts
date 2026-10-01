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
 * Viewing the app as a teammate (20261016000200): an owner opens Members, views the app as a member, sees the business
 * as they see it (no inviting, no Permissions), can't change anything, and stops. The business's audit log says who
 * looked, and as whom.
 */
test('an owner views the app as a member, read-only, until they stop', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const name = 'Seen As Plumbing';
  const { email } = await signUpAndConfirm(page, 'viewas-owner');
  const workspaceId = await createBusiness(page, { name });
  const owner = await signInOwner(email);

  // Marco joins as a member.
  const mate = uniqueEmail('viewas-mate');
  const started = Date.now();
  await api(owner.token, 'commands', 'membership.invite', {
    workspaceId,
    email: mate,
    role: 'member',
  });
  const mail = await waitForMail(mate, `invited you to ${name}`, { after: started });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const mem = await ctx.newPage();
  await signUp(mem, { name: 'Marco Tech', email: mate });
  await confirmEmail(mem, mate);
  await mem.goto(link);
  await mem.getByTestId('accept-invite').click();
  await expect(mem).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  await ctx.close();

  // The owner, as themselves: they invite, and Marco's menu offers View as.
  await page.goto(`/app/w/${workspaceId}/members`);
  await expect(page.getByTestId('invite-open')).toBeVisible();
  await page.getByRole('button', { name: 'More for Marco Tech' }).click();
  await page.getByTestId(`view-as-${mate}`).click();

  // The business as Marco sees it.
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));
  const banner = page.getByTestId('teammate-view-banner');
  await expect(banner).toContainText('You’re viewing as Marco Tech (Member).');
  await expect(page.getByRole('heading', { name: 'Welcome back, Marco' })).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/members`);
  await expect(banner).toBeVisible();
  await expect(page.getByTestId('members-table')).toBeVisible();
  await expect(page.getByTestId('invite-open')).toHaveCount(0);

  // Nothing can be changed through the view.
  await page.goto(`/app/w/${workspaceId}/customers`);
  await page.getByTestId('customers-add').click();
  await page.getByLabel('First name').fill('Not');
  await page.getByLabel('Last name').fill('Saved');
  await page.getByTestId('person-save').click();
  await expect(
    page.getByText('You’re viewing as Marco Tech, so nothing here can be changed.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // Stop viewing: back on Members as the owner.
  await banner.getByTestId('teammate-view-stop').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/members$`));
  await expect(page.getByTestId('teammate-view-banner')).toHaveCount(0);
  await expect(page.getByTestId('invite-open')).toBeVisible();

  // The audit log says who looked, and as whom.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByTestId('audit-log')).toContainText(
    'viewed the app as Marco Tech, read-only',
  );
});
