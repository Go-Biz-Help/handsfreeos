import { expect, test } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The support desk's directory (/admin/businesses) opens a business in a window over the list, not on its own page:
 * what needs a look, its numbers, plan and balance, what is set up, its people and tickets. The full page is still a
 * link away, and closing the window leaves the list where it was.
 */
test('a business opens in a quick look from the directory, tab by tab, and closes back to the list', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { email } = await signUpAndConfirm(page, 'quick-look-staff');
  const name = `Quick Look Plumbing ${Date.now()}`;
  const workspaceId = await createBusiness(page, { name });
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);

  await page.goto(`/admin/businesses?q=${encodeURIComponent(name)}`);
  await page.getByTestId(`business-row-${workspaceId}`).click();
  const look = page.getByTestId('business-quick-look');
  await expect(look.getByRole('heading', { name })).toBeVisible();
  // The list stays the page underneath.
  await expect(page).toHaveURL(/\/admin\/businesses\?/);

  // A business that has just signed up: its numbers, its owner, and nothing set up but email.
  await expect(look.getByText('Collected, 30 days')).toBeVisible();
  await look.getByRole('tab', { name: /^Set up/ }).click();
  await expect(look.getByText('Texting registration')).toBeVisible();
  await look.getByRole('tab', { name: /^People/ }).click();
  await expect(look.getByText(email)).toBeVisible();
  await look.getByRole('tab', { name: /^Tickets/ }).click();
  await expect(look.getByText('They have never written in.')).toBeVisible();

  // The full page is still there for changing anything.
  await expect(look.getByRole('link', { name: /Full page/ }).first()).toHaveAttribute(
    'href',
    `/admin/businesses/${workspaceId}`,
  );

  await page.keyboard.press('Escape');
  await expect(look).toHaveCount(0);
  await expect(page.getByTestId(`business-row-${workspaceId}`)).toBeVisible();
});
