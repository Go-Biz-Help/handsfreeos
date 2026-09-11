import { expect, test } from '@playwright/test';
import {
  createBusiness,
  linkFrom,
  PASSWORD,
  signIn,
  signOut,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';

test('sign up, confirm by email, create the business, sign out and back in with a password', async ({
  page,
}) => {
  const { email, name } = await signUpAndConfirm(page, 'owner');
  const workspaceId = await createBusiness(page, {
    name: 'Lone Star HVAC & Roofing',
    agencyName: 'Go Biz Help',
  });

  await expect(
    page.getByRole('heading', { name: `Welcome back, ${name.split(' ')[0]}` }),
  ).toBeVisible();
  await expect(page.getByTestId('setup-checklist')).toContainText('2 of 5 done');
  await expect(page.getByTestId('workspace-switcher')).toContainText('Go Biz Help');

  await signOut(page);
  await signIn(page, email);
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
});

test('wrong password and unconfirmed accounts are told what to do', async ({ page }) => {
  const email = uniqueEmail('unconfirmed');
  await signUp(page, { name: 'Test Unconfirmed', email });
  await signIn(page, email, PASSWORD, { expectSuccess: false });
  await expect(page.locator('#sign-in-error')).toContainText(/confirm your email/i);
  await signIn(page, email, 'definitely-the-wrong-password', { expectSuccess: false });
  await expect(page.locator('#sign-in-error')).toBeVisible();
});

test('forgot password sends a link that lets the user choose a new password', async ({ page }) => {
  const { email } = await signUpAndConfirm(page, 'reset');
  await createBusiness(page, { name: 'Reset Co' });
  await signOut(page);
  await page.goto('/forgot-password');
  const started = Date.now();
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByTestId('reset-sent')).toBeVisible();
  const mail = await waitForMail(email, 'Reset your HandsFreeOS password', { after: started });
  await page.goto(
    linkFrom(mail.text || mail.html, /http:\/\/localhost:3000\/auth\/confirm\?token_hash=[^\s"<]+/),
  );
  await expect(page).toHaveURL(/\/reset-password/);
  await page.getByLabel('New password').fill(`${PASSWORD}-new`);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page).toHaveURL(/\/app\/w\//);
  await signOut(page);
  await signIn(page, email, `${PASSWORD}-new`);
  await expect(page).toHaveURL(/\/app\/w\//);
});

test('theme choice is saved and survives a reload', async ({ page }) => {
  await signUpAndConfirm(page, 'theme');
  const id = await createBusiness(page, { name: 'Theme Co' });
  await page.goto(`/app/w/${id}/settings`);
  // The choice applies instantly on this device; wait for the account save before reloading.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/v1/commands/user.update_profile') && r.ok(),
  );
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await saved;
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-light').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a signed-out visitor is sent to sign-in and comes back to the page they wanted', async ({
  page,
}) => {
  await page.goto('/app');
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp/);
});
