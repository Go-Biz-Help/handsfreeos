import { expect, test } from '@playwright/test';
import {
  confirmEmail,
  createBusiness,
  linkFrom,
  PASSWORD,
  signIn,
  signOut,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';

test('owner invites a teammate; the teammate accepts the emailed link; roles and guards behave', async ({
  browser,
  page,
}) => {
  const owner = await signUpAndConfirm(page, 'inviter');
  const workspaceId = await createBusiness(page, {
    name: 'Lone Star HVAC & Roofing',
    agencyName: 'Go Biz Help',
  });
  const invitee = uniqueEmail('invitee');

  // Invite as Admin from the members page.
  await page.goto(`/app/w/${workspaceId}/members?invite=1`);
  await page.getByTestId('invite-email').fill(invitee);
  await page.getByTestId('invite-role-admin').click();
  const started = Date.now();
  await page.getByTestId('invite-send').click();
  await expect(page.getByTestId('invite-sent')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByTestId(`invite-row-${invitee}`)).toBeVisible();

  // The worker emails a single-use link.
  const mail = await waitForMail(invitee, 'invited you to Lone Star HVAC & Roofing', {
    after: started,
  });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);

  // The wrong account is refused politely.
  await page.goto(link);
  await expect(page.getByTestId('invite-wrong-account')).toContainText(owner.email);
  await page.getByTestId('switch-account').click();
  await expect(page).toHaveURL(/\/sign-in\?next=%2Finvite%2F/);

  // The invitee opens the link in a second browser context, signed out: Create an account keeps the invitation, so
  // confirming the emailed code comes straight back to it.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const other = await ctx.newPage();
  await other.goto(link);
  await expect(other).toHaveURL(/\/sign-in\?next=%2Finvite%2F/);
  await other.getByRole('link', { name: 'Create an account' }).click();
  await expect(other).toHaveURL(/\/sign-up\?next=%2Finvite%2F/);
  await other.getByLabel('Full name').fill('Test Invitee');
  await other.getByLabel('Work email').fill(invitee);
  await other.getByLabel('Password').fill(PASSWORD);
  await other.getByRole('button', { name: 'Create account' }).click();
  await confirmEmail(other, invitee);
  await expect(other).toHaveURL(link);
  await expect(other.getByTestId('accept-invite')).toBeVisible();
  await other.getByTestId('accept-invite').click();
  await expect(other).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  await other.goto(`/app/w/${workspaceId}/members`);
  await expect(other.getByTestId(`member-row-${invitee}`)).toContainText('You');

  // A used link says so.
  await other.goto(link);
  await expect(other.getByTestId('invite-used')).toBeVisible();

  // Admin cannot touch the Owner's role: the select is disabled; they cannot change their own either.
  await other.goto(`/app/w/${workspaceId}/members`);
  await expect(other.getByLabel(`Role for ${owner.name}`)).toBeDisabled();
  await expect(other.getByLabel('Role for Test Invitee')).toBeDisabled();

  // Back as the owner: change the teammate to Member, then confirm the last-owner guard.
  await signIn(page, owner.email);
  await page.goto(`/app/w/${workspaceId}/members`);
  await expect(page.getByLabel('Role for Test Invitee')).toBeEnabled();
  await page.getByLabel('Role for Test Invitee').selectOption('member');
  await expect(page.getByText(/is now Member/)).toBeVisible();
  await page.getByRole('button', { name: `More for ${owner.name}` }).click();
  await page.getByRole('menuitem', { name: 'Leave workspace' }).click();
  await page.getByTestId('confirm-remove').click();
  await expect(page.getByText(/at least one owner/)).toBeVisible();

  // The audit log tells the story, including the worker's email.
  await page.goto(`/app/w/${workspaceId}/audit`);
  await expect(page.getByTestId('audit-log')).toContainText('emailed the invitation link');
  await expect(page.getByTestId('audit-log')).toContainText(`invited ${invitee}`);
  await expect(page.getByTestId('audit-log')).toContainText(
    "changed Test Invitee's role from Admin to Member",
  );

  // Remove the teammate; they no longer see the workspace.
  await page.goto(`/app/w/${workspaceId}/members`);
  await page.getByRole('button', { name: 'More for Test Invitee' }).click();
  await page.getByRole('menuitem', { name: 'Remove from workspace' }).click();
  await page.getByTestId('confirm-remove').click();
  await expect(page.getByTestId(`member-row-${invitee}`)).toHaveCount(0);
  await other.goto(`/app/w/${workspaceId}`);
  await expect(other.getByRole('heading', { name: 'We could not find that' })).toBeVisible();
  await ctx.close();
  await signOut(page);
});
