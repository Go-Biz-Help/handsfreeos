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

export async function confirmEmail(page: Page, email: string): Promise<void> {
  const mail = await waitForMail(email, 'Confirm your HandsFreeOS email');
  const link = linkFrom(
    mail.text || mail.html,
    /http:\/\/localhost:3000\/auth\/confirm\?token_hash=[^\s"<]+/,
  );
  await page.goto(link);
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

export async function createBusiness(
  page: Page,
  opts: { name: string; agencyName?: string },
): Promise<string> {
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel('Business name').fill(opts.name);
  if (opts.agencyName) {
    await page.getByRole('switch').click();
    await page.getByLabel('Agency name').fill(opts.agencyName);
  }
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/app\/w\/[0-9a-f-]{36}$/);
  return /\/app\/w\/([0-9a-f-]{36})/.exec(page.url())![1]!;
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
