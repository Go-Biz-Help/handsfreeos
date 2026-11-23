import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The guided payments setup from Settings → Payments (the owner, 23 Nov 2026, picks P1 a to P4 a): the page is one
 * simple card with every setting from before under All settings. Set up payments asks one question at a time and
 * saves as it goes; Save and connect signs in to Stripe last; the page then shows the account and each answer with
 * Change, which opens that one question.
 */
test('Settings → Payments: Set up payments, saved as it goes, the sign-in last, then each answer with Change', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signUpAndConfirm(page, 'payments-setup');
  const workspaceId = await createBusiness(page, { name: 'Lone Star Pay Roofing' });

  // One simple card: no account and no answers yet, and All settings opens and closes everything from before.
  await page.goto(`/app/w/${workspaceId}/settings/payments`);
  await expect(page.getByTestId('payments-overview')).toBeVisible();
  await expect(page.getByTestId('payments-answers')).toHaveCount(0);
  await expect(page.getByTestId('payments-all-settings')).toBeHidden();
  await page.getByTestId('payments-all-settings-toggle').click();
  await expect(page.getByTestId('pay-no-accounts')).toBeVisible();
  await page.getByTestId('payments-all-settings-toggle').click();
  await expect(page.getByTestId('payments-all-settings')).toBeHidden();

  // Set up payments: Stripe first, then what customers pay with, then sales tax, which is theirs to say.
  await expect(page.getByTestId('payments-set-up')).toHaveText('Start');
  await page.getByTestId('payments-set-up').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/payments$`));
  const card = page.getByTestId('payments-setup');
  await expect(card).toHaveAttribute('data-screen', 'where', { timeout: 60_000 });
  const next = page.getByTestId('payments-setup-next');
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'ways');
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'tax');
  await page.getByTestId('payments-setup-tax-yes').click();
  await page.getByTestId('payments-setup-tax-rate').fill('8.25');
  await page.getByTestId('payments-setup-tax-name').fill('Sales tax');
  await next.click();

  // Saved as it goes: Settings → Payments offers to pick up where they left off, on the same question.
  await expect(card).toHaveAttribute('data-screen', 'due');
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/settings/payments`);
  await expect(page.getByTestId('payments-set-up')).toHaveText('Pick up where you left off');
  await page.getByTestId('payments-set-up').click();
  await expect(card).toHaveAttribute('data-screen', 'due', { timeout: 60_000 });
  await expect(page.getByTestId('guided-step-tax')).toContainText('8.25%');
  for (const screen of ['estimates', 'reminders', 'documents']) {
    await next.click();
    await expect(card).toHaveAttribute('data-screen', screen);
  }
  await next.click();

  // Check it over, then Save and connect Stripe: the sign-in (the stand-in) comes back to Done.
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(page.getByTestId('payments-review-tax')).toContainText('8.25%');
  await expect(next).toHaveText('Save and connect Stripe');
  await next.click();
  await page.waitForURL(/\/oauth\/fake\/payments\/stripe\/authorize/);
  await page.locator('#account').fill(`acct_setup_${randomUUID().slice(0, 8)}`);
  await page.getByTestId('fake-connect').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/payments\\?done=1`));
  await expect(page.getByTestId('payments-setup-done-chips')).toContainText('8.25% sales tax');
  await expect(page.getByTestId('payments-setup-not-connected')).toHaveCount(0);
  await expect(page.getByTestId('payments-setup-done-close')).toHaveText('Back to Settings');
  await page.getByTestId('payments-setup-done-close').click();

  // The card: the account money goes into, and each answer with Change.
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/payments$`));
  await expect(page.getByTestId('payments-account')).toContainText('Stripe');
  await expect(page.getByTestId('payments-set-up')).toHaveCount(0);
  await expect(page.getByTestId('payments-answer-tax')).toContainText('8.25%');
  await expect(page.getByTestId('payments-answer-where')).toHaveCount(0);

  // Change opens that one question; Next goes straight to Check it over, and Save goes back to Settings.
  await page.getByTestId('payments-answer-change-tax').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/payments\\?at=tax$`));
  await expect(card).toHaveAttribute('data-screen', 'tax', { timeout: 60_000 });
  await page.getByTestId('payments-setup-tax-rate').fill('7');
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(next).toHaveText('Save my answers');
  await next.click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/payments$`));
  await expect(page.getByTestId('payments-answer-tax')).toContainText('7%');
});
