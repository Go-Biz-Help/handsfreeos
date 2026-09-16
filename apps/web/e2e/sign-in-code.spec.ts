import { expect, test, type Page } from '@playwright/test';
import { createBusiness, signOut, signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';

/**
 * Email me a code (M10): an existing account signs in with a 6-digit code from Mailpit, typed or pasted; a wrong code
 * says so and lets them try again; an address with no account is told to check it or create one; and "Use my password
 * instead" goes back to the password.
 */

const SUBJECT = 'Your HandsFreeOS sign-in code';

/** The 6-digit code in the newest sign-in email to `email` sent after `after`. */
async function codeFor(email: string, after: number): Promise<string> {
  const mail = await waitForMail(email, SUBJECT, { after });
  const code = /\b(\d{6})\b/.exec(mail.text || mail.html.replace(/<[^>]+>/g, ' '))?.[1];
  if (!code) throw new Error('no 6-digit code in the sign-in email');
  return code;
}

async function askForCode(page: Page, email: string): Promise<number> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  const sentAt = Date.now();
  await page.getByTestId('email-me-a-code').click();
  return sentAt;
}

test('an existing account signs in with an emailed code', async ({ page }) => {
  const { email } = await signUpAndConfirm(page, 'code-sign-in');
  const workspaceId = await createBusiness(page, { name: 'Code Sign-in HVAC' });
  await signOut(page);

  // The code needs the email address first.
  await page.goto('/sign-in');
  await page.getByTestId('email-me-a-code').click();
  await expect(
    page.getByText('Enter your email address first, then press Email me a code.'),
  ).toBeVisible();

  const sentAt = await askForCode(page, email);
  const step = page.getByTestId('code-step');
  await expect(step.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(step).toContainText(`We sent a 6-digit code to ${email}.`);
  await expect(page.getByTestId('resend-wait')).toContainText(/Send another code in 0:\d\d/);
  const code = await codeFor(email, sentAt);

  // A wrong code is refused and cleared to try again.
  const wrong = code === '000000' ? '111111' : '000000';
  await page.getByLabel('6-digit code').fill(wrong);
  await expect(page.locator('#code-error')).toContainText(
    'That code isn’t right, or it has expired.',
  );
  await expect(page).toHaveURL(/\/sign-in/);

  // The right one, pasted whole, signs in.
  await page.getByLabel('6-digit code').fill(code);
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
});

test('no account for the address, and back to the password', async ({ page }) => {
  await askForCode(page, uniqueEmail('code-nobody'));
  await expect(page.locator('#code-send-error')).toContainText(
    'There’s no HandsFreeOS account for that email. Check it, or create an account.',
  );
  await expect(page.getByTestId('code-step')).toHaveCount(0);

  const { email } = await signUpAndConfirm(page, 'code-back');
  await createBusiness(page, { name: 'Code Back Co' });
  await signOut(page);
  await askForCode(page, email);
  await expect(page.getByTestId('code-step')).toBeVisible();
  await page.getByRole('button', { name: 'Use my password instead' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
});
