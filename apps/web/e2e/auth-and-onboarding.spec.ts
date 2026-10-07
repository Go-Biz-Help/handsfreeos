import { expect, test } from '@playwright/test';
import {
  codeFrom,
  createBusiness,
  linkFrom,
  MAILPIT,
  PASSWORD,
  SIGN_UP_SUBJECT,
  signIn,
  signOut,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';

/** The newest of the sign-up emails to `email`, once there are `count` of them. */
async function newestSignUpMail(
  email: string,
  count: number,
): Promise<{ text: string; html: string }> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}&limit=20`,
    );
    const { messages } = (await res.json()) as {
      messages: { ID: string; Subject: string; Created: string }[];
    };
    const found = messages
      .filter((m) => m.Subject.includes(SIGN_UP_SUBJECT))
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created));
    if (found.length >= count) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${found[0]!.ID}`)).json()) as {
        Text: string;
        HTML: string;
      };
      return { text: full.Text, html: full.HTML };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`fewer than ${count} sign-up emails to ${email}`);
}

test('sign up, confirm with the emailed code, create the business, sign out and back in with a password', async ({
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
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 9 done');
  await expect(page.getByTestId('workspace-switcher')).toContainText('Go Biz Help');

  await signOut(page);
  await signIn(page, email);
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
});

test('the sign-up code: a wrong one is refused, and the email can be changed', async ({ page }) => {
  const email = uniqueEmail('signup-code');
  await signUp(page, { name: 'Test Code', email });
  const step = page.getByTestId('check-email');
  await expect(step).toContainText(`We sent a 6-digit code to ${email}.`);
  await expect(step).toContainText('expires in one hour');
  await expect(step.getByTestId('resend-wait')).toContainText(/Send another code in 0:\d\d/);
  const code = codeFrom(await waitForMail(email, SIGN_UP_SUBJECT));

  const wrong = code === '000000' ? '111111' : '000000';
  await step.getByLabel('6-digit code').fill(wrong);
  await expect(page.locator('#code-error')).toContainText(
    'That code isn’t right, or it has expired.',
  );
  await expect(page).toHaveURL(/\/sign-up/);

  // Use a different email goes back to the form, as it was but for the password.
  await step.getByRole('button', { name: 'Use a different email' }).click();
  await expect(page.getByLabel('Work email')).toHaveValue(email);
  await expect(page.getByLabel('Password')).toHaveValue('');
});

test('an address that already has an account is told to sign in', async ({ page }) => {
  const { email } = await signUpAndConfirm(page, 'twice');
  await createBusiness(page, { name: 'Twice Co' });
  await signOut(page);
  await page.goto('/sign-up');
  await page.getByLabel('Full name').fill('Test Twice');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByText('That email already has an account. Sign in instead.')).toBeVisible();
  await expect(page.getByTestId('check-email')).toHaveCount(0);
});

test('a wrong password is told so; an unconfirmed account confirms with a code from sign-in', async ({
  page,
}) => {
  const email = uniqueEmail('unconfirmed');
  await signUp(page, { name: 'Test Unconfirmed', email });
  // They leave without typing the code, and come back another day to sign in.
  await signIn(page, email, 'definitely-the-wrong-password', { expectSuccess: false });
  await expect(page.locator('#sign-in-error')).toContainText(
    'That email and password do not match.',
  );
  // Supabase sends no second sign-up email within `max_frequency` (1s in supabase/config.toml) of the first, and
  // sign-in then shows the code step without one. Wait that out, so signing in sends a new code.
  await page.waitForTimeout(1_500);
  await signIn(page, email, PASSWORD, { expectSuccess: false });
  const step = page.getByTestId('confirm-email');
  await expect(step.getByRole('heading', { name: 'Confirm your email' })).toBeVisible();
  await expect(step).toContainText(`we sent a 6-digit code to ${email}`);
  // Sending another replaces the code from signing up: the newest one works.
  await step.getByLabel('6-digit code').fill(codeFrom(await newestSignUpMail(email, 2)));
  await expect(page).toHaveURL(/\/onboarding/);
  await expect(page.getByLabel('Business name')).toBeVisible();
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
