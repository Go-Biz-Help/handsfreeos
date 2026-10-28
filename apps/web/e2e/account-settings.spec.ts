import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import {
  confirmEmail,
  createBusiness,
  linkFrom,
  signUp,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';
import { setUpTexting } from './telephony';

/**
 * Settings → Account for the phone app (M10): push beside email in one grid, saved whole; My cell phone verified by a
 * call from the business number (the fake carrier answers and presses 1); what forwarded phones show, in Texting &
 * calls; and Delete my account, from a founder who first makes a teammate an owner in Members, and from an account in no
 * business on the public page.
 */

type Settings = { push?: Record<string, boolean>; notifications?: Record<string, boolean> };

test('notifications: push beside email, each saved whole', async ({ page }) => {
  const { email } = await signUpAndConfirm(page, 'notify-grid');
  const workspaceId = await createBusiness(page, { name: 'Notify Grid HVAC' });
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(page.getByTestId('push-phones')).toHaveText('No phones yet');

  const payPush = page.getByTestId('push-payment');
  const digestEmail = page.getByTestId('email-attentionDigest');
  await expect(payPush).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('push-urgent')).toHaveAttribute('aria-checked', 'true');
  await payPush.click();
  await expect(page.getByText('A customer pays: push on')).toBeVisible();
  await expect(payPush).toBeEnabled();
  await digestEmail.click();
  await expect(page.getByText('Morning summary: email off')).toBeVisible();
  await expect(digestEmail).toBeEnabled();

  await page.reload();
  await expect(page.getByTestId('push-payment')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('email-attentionDigest')).toHaveAttribute('aria-checked', 'false');
  // A row with no email shows a dash; approvals always email.
  const approvals = page.getByRole('row', { name: /Approvals/ });
  await expect(approvals).toContainText('Always');
  // New support tickets is a row only for people who answer HandsFreeOS support.
  await expect(page.getByTestId('push-supportTickets')).toHaveCount(0);

  const { token } = await signInOwner(email);
  const me = await api<{ user: { settings: Settings } }>(token, 'queries', 'account.me', {});
  // All fourteen, in the order `PushSwitches` declares them (packages/core/src/push.ts). Exact equality on
  // purpose: a switch arriving without anybody deciding it should is the thing this catches. New support
  // tickets is saved with the rest, though only support people see its row. `qualifying` (20261018000400): the AI
  // teammate's qualifying, a lead qualifying or a file coming in. `documents` (20261027015200): a document you
  // sent was signed, declined or ran out of time.
  expect(me.user.settings.push).toEqual({
    customerWaiting: true,
    missedCall: true,
    urgent: true,
    approval: true,
    booking: true,
    assigned: true,
    payment: true,
    wallet: true,
    jobs: true,
    connections: true,
    addons: true,
    supportTickets: true,
    qualifying: true,
    documents: true,
  });
  expect(me.user.settings.notifications).toMatchObject({
    attentionDigest: false,
    unansweredEmail: true,
  });
});

test('my cell phone is verified by a call from the business number; forwarded phones can show that number', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'my-cell');
  const workspaceId = await createBusiness(page, { name: 'My Cell HVAC' });

  // No business number yet: nothing can call the cell.
  await page.goto(`/app/w/${workspaceId}/settings`);
  const cell = page.getByTestId('my-cell');
  await expect(cell).toContainText('needs a business number before HandsFreeOS can call your cell');
  await expect(page.getByTestId('verify-my-cell')).toBeDisabled();

  const businessNumber = await setUpTexting(page, workspaceId);
  const display = `(${businessNumber.slice(2, 5)}) ${businessNumber.slice(5, 8)}-${businessNumber.slice(8)}`;

  await page.goto(`/app/w/${workspaceId}/settings`);
  await page.getByLabel('Your cell number').fill('(512) 555-0177');
  await page.getByTestId('verify-my-cell').click();
  await expect(page.getByTestId('verify-calling')).toContainText(
    'We’ll call (512) 555-0177. Press 1 when you answer.',
  );
  await expect(page.getByTestId('verify-calling')).toContainText(display);
  // The stand-in carrier rings it, answers and presses 1.
  await expect(cell.getByText('Verified', { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(cell).toContainText(`Save ${display}`);
  await page.reload();
  await expect(page.getByTestId('my-cell-number')).toHaveText('(512) 555-0177');
  await expect(page.getByTestId('my-cell').getByText('Verified', { exact: true })).toBeVisible();

  // Texting & calls: forwarded phones show the business number, and it stays when routing is saved.
  await page.goto(`/app/w/${workspaceId}/settings/texting`);
  const business = page.getByTestId('caller-id-business');
  await expect(page.getByTestId('caller-id-customer')).toHaveAttribute('aria-checked', 'true');
  await business.click();
  await expect(page.getByText(`Forwarded phones show ${display}`)).toBeVisible();
  await page.getByLabel('Ring for').selectOption('15');
  await expect(page.getByText('Rings for 15 seconds')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('caller-id-business')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Ring for')).toHaveValue('15');
});

test('a founder makes a teammate an owner in Members, then deletes their account', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const dale = await signUpAndConfirm(page, 'delete-founder');
  const workspaceId = await createBusiness(page, { name: 'Hand Over HVAC' });

  await page.goto(`/app/w/${workspaceId}/settings`);
  const callout = page.getByTestId(`only-owner-${workspaceId}`);
  await expect(callout).toContainText('You’re the only owner of Hand Over HVAC.');
  await expect(callout).toContainText('Invite someone and make them an owner first');
  await expect(page.getByTestId('delete-my-account')).toBeDisabled();
  await expect(page.getByText('Available once someone else owns Hand Over HVAC.')).toBeVisible();

  // Priya joins as an admin.
  const priyaEmail = uniqueEmail('delete-priya');
  const invitedAt = Date.now();
  await page.goto(`/app/w/${workspaceId}/members?invite=1`);
  await page.getByTestId('invite-email').fill(priyaEmail);
  await page.getByTestId('invite-role-admin').click();
  await page.getByTestId('invite-send').click();
  await expect(page.getByTestId('invite-sent')).toBeVisible();
  const mail = await waitForMail(priyaEmail, 'invited you to Hand Over HVAC', { after: invitedAt });
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);
  const context = await browser.newContext();
  const other = await context.newPage();
  await signUp(other, { name: 'Priya Natarajan', email: priyaEmail });
  await confirmEmail(other, priyaEmail);
  await other.goto(link);
  await other.getByTestId('accept-invite').click();
  await expect(other).toHaveURL(new RegExp(`/app/w/${workspaceId}`));

  // The page names her, and Open Members is where she becomes an owner.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(callout).toContainText('Make Priya or someone else an owner first');
  await callout.getByRole('link', { name: 'Open Members' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/members`));
  await page.getByLabel('Role for Priya Natarajan').selectOption('owner');
  await expect(page.getByText('Priya Natarajan is now Owner.')).toBeVisible();

  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(page.getByTestId('hands-over')).toHaveText(
    'Hand Over HVAC stays with Priya Natarajan, its other owner.',
  );
  const remove = page.getByTestId('delete-my-account');
  await expect(remove).toBeDisabled();
  await page.getByLabel('Type your email address to confirm').fill(dale.email.toUpperCase());
  await remove.click();
  await expect(page).toHaveURL(/\/sign-in\?error=deleted/);
  await expect(page.getByTestId('account-deleted')).toBeVisible();

  // The worker finishes it: sign-in is refused, and Priya owns the business and its organization.
  await expect(async () => {
    await expect(signInOwner(dale.email)).rejects.toThrow();
  }).toPass({ timeout: 60_000 });
  const { token } = await signInOwner(priyaEmail);
  const me = await api<{
    organizations: { role: string }[];
    workspaces: { id: string; role: string }[];
  }>(token, 'queries', 'account.me', {});
  expect(me.organizations.map((o) => o.role)).toEqual(['owner']);
  expect(me.workspaces.find((w) => w.id === workspaceId)?.role).toBe('owner');
  await context.close();
});

test('the public page: how to delete an account, and deleting one that belongs to no business', async ({
  page,
}) => {
  await page.goto('/delete-account');
  await expect(
    page.getByRole('heading', { name: 'Delete your HandsFreeOS account' }),
  ).toBeVisible();
  await expect(page.getByText('What each business keeps')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to delete my account' })).toHaveAttribute(
    'href',
    '/sign-in?next=%2Fdelete-account',
  );

  // Signed up but never made a business: there are no business settings, so it's done here.
  const loner = await signUpAndConfirm(page, 'delete-loner');
  await expect(page).toHaveURL(/\/onboarding/);
  await page.goto('/delete-account');
  const remove = page.getByTestId('delete-my-account');
  await page.getByLabel('Type your email address to confirm').fill(loner.email);
  await remove.click();
  await expect(page).toHaveURL(/\/sign-in\?error=deleted/);
  await expect(async () => {
    await expect(signInOwner(loner.email)).rejects.toThrow();
  }).toPass({ timeout: 60_000 });
});
