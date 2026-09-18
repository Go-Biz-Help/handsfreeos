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
