import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery-staple';
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:54424';

export const uniqueEmail = (label: string): string =>
  `${label}-${randomUUID().slice(0, 8)}@hfos.test`;

interface MailpitSummary {
  ID: string;
  Subject: string;
  Created: string;
}

export async function waitForMail(
  to: string,
  subjectIncludes: string,
  opts: { after?: number; timeoutMs?: number } = {},
): Promise<{ id: string; text: string; html: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const query = encodeURIComponent(`to:"${to}"`);
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${query}&limit=20`);
    const { messages } = (await res.json()) as { messages: MailpitSummary[] };
    const hit = messages.find(
      (m) =>
        m.Subject.includes(subjectIncludes) &&
        (!opts.after || new Date(m.Created).getTime() >= opts.after - 2000),
    );
    if (hit) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as {
        Text: string;
        HTML: string;
      };
      return { id: hit.ID, text: full.Text, html: full.HTML };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no email to ${to} with subject containing "${subjectIncludes}"`);
}

export function linkFrom(body: string, pattern: RegExp): string {
  const m = pattern.exec(body.replace(/&amp;/g, '&'));
  if (!m) throw new Error(`no link matching ${pattern} in email`);
  return m[0];
}

/** The 6-digit code in an email: signing up's, or Email me a code's. */
export function codeFrom(mail: { text: string; html: string }): string {
  const code = /\b(\d{6})\b/.exec(mail.text || mail.html.replace(/<[^>]+>/g, ' '))?.[1];
  if (!code) throw new Error('no 6-digit code in the email');
  return code;
}

export const SIGN_UP_SUBJECT = 'Confirm your HandsFreeOS email';

export async function signUp(
  page: Page,
  opts: { name: string; email: string; password?: string },
): Promise<void> {
  await page.goto('/sign-up');
  await page.getByLabel('Full name').fill(opts.name);
  await page.getByLabel('Work email').fill(opts.email);
  await page.getByLabel('Password').fill(opts.password ?? PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('check-email')).toBeVisible();
}

/** Types the code from the sign-up email where the account is being made, and waits until it's signed in. */
export async function confirmEmail(page: Page, email: string): Promise<void> {
  const mail = await waitForMail(email, SIGN_UP_SUBJECT);
  await page.getByTestId('check-email').getByLabel('6-digit code').fill(codeFrom(mail));
  await expect(page).not.toHaveURL(/\/sign-up/);
}

export async function signUpAndConfirm(
  page: Page,
  label: string,
): Promise<{ email: string; name: string }> {
  const email = uniqueEmail(label);
  const name = `Test ${label}`;
  await signUp(page, { name, email });
  await confirmEmail(page, email);
  return { email, name };
}

/** The address `createBusiness` gives: in Chicago, so the business is on Central time, as every one was before. */
export const BUSINESS_ADDRESS = {
  line1: '233 S Wacker Dr',
  city: 'Chicago',
  state: 'IL',
  postalCode: '60606',
} as const;

/**
 * The guided setup's first screen, which makes the business: general home services in Chicago, as every business
 * was before setup asked, and a website only when one is given. Then Home, as Finish later would, unless `setup`
 * stays on the setup's next screen (onboarding-setup.spec.ts goes through the rest).
 */
export async function createBusiness(
  page: Page,
  opts: { name: string; agencyName?: string; website?: string; setup?: boolean },
): Promise<string> {
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByTestId('setup-business-name').fill(opts.name);
  await page.getByTestId('setup-kind-button-home').click();
  await page.getByTestId('setup-kind-home_services').click();
  await page.getByTestId('setup-line1').fill(BUSINESS_ADDRESS.line1);
  await page.getByTestId('setup-city').fill(BUSINESS_ADDRESS.city);
  await page.getByTestId('setup-state').selectOption(BUSINESS_ADDRESS.state);
  await page.getByTestId('setup-postal-code').fill(BUSINESS_ADDRESS.postalCode);
  if (opts.website) await page.getByTestId('ai-setup-website-input').fill(opts.website);
  if (opts.agencyName) {
    await page.getByTestId('setup-agency').click();
    await page.getByTestId('setup-agency-name').fill(opts.agencyName);
  }
  await page.getByTestId('onboarding-setup-next').click();
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}\?at=goal$/);
  await expect(page.getByTestId('onboarding-setup')).toHaveAttribute('data-screen', 'goal');
  const id = /\/onboarding\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  if (opts.setup) return id;
  await page.goto(`/app/w/${id}`);
  await expect(page).toHaveURL(new RegExp(`/app/w/${id}$`));
  return id;
}

export async function signIn(
  page: Page,
  email: string,
  password = PASSWORD,
  opts: { expectSuccess?: boolean } = {},
): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  // Sign-in completes client-side; wait for the redirect so the session cookie exists before the next goto.
  if (opts.expectSuccess ?? true) await expect(page).not.toHaveURL(/\/sign-in/);
}

export async function signOut(page: Page): Promise<void> {
  await page.getByTestId('sign-out').click();
  await expect(page).toHaveURL(/\/sign-in/);
}
