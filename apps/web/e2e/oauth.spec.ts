import { expect, test } from '@playwright/test';

test('the Google button starts an OAuth flow against Supabase (never hits Google in tests)', async ({
  page,
}) => {
  let authorizeUrl = '';
  await page.route('**/auth/v1/authorize**', async (route) => {
    authorizeUrl = route.request().url();
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>stubbed</p>' });
  });
  await page.goto('/sign-in');
  await page.getByTestId('google-sign-in').click();
  await page.waitForURL(/\/auth\/v1\/authorize/);
  expect(authorizeUrl).toContain('provider=google');
  expect(authorizeUrl).toContain(encodeURIComponent('http://localhost:3000/auth/callback'));
});

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
