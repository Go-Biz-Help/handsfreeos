import { expect, test } from '@playwright/test';

test('the OAuth callback never redirects off-site and rejects bad codes', async ({ page }) => {
  const res = await page.goto(
    '/auth/callback?code=not-a-real-code&next=https://evil.example/phish',
  );
  expect(res?.url()).toMatch(/\/sign-in\?error=oauth$/);
  await page.goto('/auth/confirm?token_hash=nope&type=signup');
  await expect(page).toHaveURL(/\/sign-in\?error=link/);
  await page.goto('/sign-in?next=//evil.example');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});

test('a deleted account’s Google sign-in says the account is no longer available', async ({
  page,
}) => {
  // What Supabase sends back when the Google account belongs to a banned (deleted) sign-in.
  const res = await page.goto(
    '/auth/callback?error=access_denied&error_code=user_banned&error_description=User+is+banned',
  );
  expect(res?.url()).toMatch(/\/sign-in\?error=account$/);
  await expect(page.getByText('That account is no longer available.')).toBeVisible();
});

test('Continue with Google shows only once Google is turned on in Supabase', async ({ page }) => {
  // The local stack has Google off (supabase/config.toml), so neither page offers it.
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByTestId('google-sign-in')).toHaveCount(0);
  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByTestId('google-sign-in')).toHaveCount(0);
});
