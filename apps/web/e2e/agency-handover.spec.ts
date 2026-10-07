import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import {
  BUSINESS_ADDRESS,
  confirmEmail,
  createBusiness,
  linkFrom,
  PASSWORD,
  signUpAndConfirm,
  uniqueEmail,
  waitForMail,
} from './helpers';

/**
 * An agency sets up a client's business and hands it to the owner (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md
 * §9, the owner's 53A and 54A). Added from Client businesses for someone else, the setup leaves the owner what's
 * theirs: the booking page isn't made, payments aren't signed in to, and the phone's contacts wait for them. In
 * place of "Stay in the loop" the agency hands it over with the owner's email, and saves its answers for its other
 * businesses, which start from them. The owner's invitation says what was set up for them; accepting it opens on
 * what the agency did, to check, Home's card says so too, and "Finish my part" walks only their own screens, Stripe's
 * sign-in coming back to them.
 */
test('an agency sets up a client’s business, hands it to the owner, and the owner checks it and finishes', async ({
  browser,
  page,
}) => {
  test.setTimeout(360_000);
  const agency = await signUpAndConfirm(page, 'handover-agency');
  const own = await createBusiness(page, {
    name: 'Handover Agency HQ',
    agencyName: 'Handover Agency',
  });
  const { token } = await signInOwner(agency.email);
  const me = await api<{ workspaces: { id: string; organizationId: string }[] }>(
    token,
    'queries',
    'account.me',
    {},
  );
  const orgId = me.workspaces.find((w) => w.id === own)!.organizationId;

  // 1. Client businesses → Add a client business, for someone else: the setup opens on it.
  await page.goto(`/app/org/${orgId}/businesses`);
  await page.getByTestId('add-client-business').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Business name').fill('Curl Up Salon');
  await expect(dialog.getByLabel('Who runs this business?')).toHaveValue('client');
  await dialog.getByRole('button', { name: 'Add business' }).click();
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const salon = /\/onboarding\/([0-9a-f-]{36})/.exec(page.url())![1]!;

  const setup = page.getByTestId('onboarding-setup');
  const counter = page.getByTestId('onboarding-setup-counter');
  const title = setup.getByRole('heading', { level: 1 });
  const next = page.getByTestId('onboarding-setup-next');
  const at = (screen: string) => expect(setup).toHaveAttribute('data-screen', screen);

  await at('business');
  await expect(page.getByTestId('setup-business-name')).toHaveValue('Curl Up Salon');
  await page.getByTestId('setup-kind-button-beauty').click();
  await page.getByTestId('setup-kind-hair_salon').click();
  await page.getByTestId('setup-line1').fill(BUSINESS_ADDRESS.line1);
  await page.getByTestId('setup-city').fill(BUSINESS_ADDRESS.city);
  await page.getByTestId('setup-state').selectOption(BUSINESS_ADDRESS.state);
  await page.getByTestId('setup-postal-code').fill(BUSINESS_ADDRESS.postalCode);
  await page.getByTestId('ai-setup-no-website').click();
  await next.click();

  await at('goal');
  await page.getByTestId('setup-goal-paid').click();
  await next.click();
  await at('about');
  await page.getByTestId('ai-setup-description').fill('Cuts and colour on Wacker Drive.');
  await page.getByTestId('ai-setup-add-service').click();
  await page.getByTestId('ai-setup-service-0-name').fill('Haircut');
  await page.getByTestId('ai-setup-service-0-price').fill('45');
  await next.click();
  for (const screen of ['hours', 'look', 'page']) {
    await at(screen);
    await next.click();
  }

  // 2. What's the owner's waits for them: their phone's contacts, their booking page and their payments.
  await at('customers');
  await page.getByTestId('setup-customers-phone').click();
  await expect(setup).toContainText(
    'The owner picks them one by one in the phone app, once they join.',
  );
  await expect(page.getByTestId('setup-customers-app')).toHaveCount(0);
  await next.click();
  await at('booking');
  await expect(title).toHaveText('The booking page is the owner’s');
  await expect(page.getByTestId('setup-booking-making')).toHaveCount(0);
  await expect(page.getByTestId('setup-booking-changes')).toHaveCount(0);
  await next.click();
  await at('number');
  await page.getByTestId('setup-ein-yes').click();
  await next.click();
  await at('paid');
  await page.getByTestId('setup-pay-stripe').click();
  await expect(setup).toContainText(
    'The owner signs in to Stripe when they finish, so payments go to their own account.',
  );
  await expect(page.getByTestId('setup-pay-connect')).toHaveCount(0);
  await next.click();
  for (let i = 0; i < 8 && (await setup.getAttribute('data-screen')) !== 'loop'; i++) {
    const screen = (await setup.getAttribute('data-screen'))!;
    await next.click();
    await expect(setup).not.toHaveAttribute('data-screen', screen);
  }

  // 3. Handed over in place of "Stay in the loop", inviting the owner as the owner: an owner of the agency may.
  await at('loop');
  await expect(counter).toContainText('Hand it over');
  await expect(title).toHaveText('Hand it to the owner');
  await expect(setup).toContainText('They join as the owner of this business.');
  await expect(next).toHaveText('Save and hand it over');
  const owner = uniqueEmail('handover-owner');
  await page.getByTestId('setup-owner-email').fill(owner);
  const handed = Date.now();
  await next.click();
  await at('try');
  await expect(page.getByTestId('onboarding-setup-handed-over')).toHaveText(
    `${owner} has an email to check it and finish their part.`,
  );
  await expect(page.getByTestId('ai-setup-try')).toBeVisible({ timeout: 60_000 });

  // 4. Its answers, saved for the agency's other businesses; never the salon's own name, services or customers.
  await page.getByTestId('ai-setup-save-for-others').click();
  await expect(page.getByTestId('ai-setup-save-name')).toHaveValue('Salons and spas');
  await page.getByTestId('ai-setup-save-name').fill('Salons');
  await page.getByTestId('ai-setup-save-for-others-save').click();
  await expect(page.getByTestId('ai-setup-saved-for-others')).toContainText('Saved as “Salons”.');
  await page.getByTestId('ai-setup-not-yet').click();
  await at('done');
  await expect(page.getByTestId('onboarding-setup-handed-over')).toBeVisible();
  // Nothing's left for the agency on the salon's Home.
  await page.goto(`/app/w/${salon}`);
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await expect(page.getByTestId('getting-started-setup')).toHaveCount(0);

  // Another of its businesses starts from them: what they want help with first, the hours and payments too.
  const { items } = await api<{ items: { id: string; name: string }[] }>(
    token,
    'queries',
    'ai_setup_template.list',
    { organizationId: orgId },
  );
  const salons = items.find((t) => t.name === 'Salons')!.id;
  const { workspaceId: bloom } = await api<{ workspaceId: string }>(
    token,
    'commands',
    'workspace.create',
    { organizationId: orgId, name: 'Bloom Hair' },
  );
  await page.goto(`/onboarding/${bloom}`);
  await at('business');
  await page.getByTestId('setup-kind-button-beauty').click();
  await page.getByTestId('setup-kind-hair_salon').click();
  const saved = page.getByTestId(`ai-setup-start-${salons}`);
  await expect(saved).toHaveAttribute('aria-checked', 'true');
  await expect(saved).toContainText('Getting paid');
  await expect(saved).toContainText('Customers pay with Stripe');
  await page.getByTestId('setup-line1').fill(BUSINESS_ADDRESS.line1);
  await page.getByTestId('setup-city').fill(BUSINESS_ADDRESS.city);
  await page.getByTestId('setup-state').selectOption(BUSINESS_ADDRESS.state);
  await page.getByTestId('setup-postal-code').fill(BUSINESS_ADDRESS.postalCode);
  await page.getByTestId('ai-setup-no-website').click();
  await next.click();
  await at('goal');
  await expect(page.getByTestId('setup-goal-paid')).toHaveAttribute('aria-checked', 'true');

  // 5. The owner's invitation says what was set up for them.
  const mail = await waitForMail(owner, 'set up Curl Up Salon on HandsFreeOS for you', {
    after: handed,
  });
  expect(mail.text).toContain(`${agency.name} at Handover Agency set up Curl Up Salon`);
  const link = linkFrom(mail.text, /http:\/\/localhost:3000\/invite\/inv_[A-Za-z0-9_-]+/);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const other = await ctx.newPage();
  await other.goto(link);
  await other.getByRole('link', { name: 'Create an account' }).click();
  await other.getByLabel('Full name').fill('Carla Curl');
  await other.getByLabel('Work email').fill(owner);
  await other.getByLabel('Password').fill(PASSWORD);
  await other.getByRole('button', { name: 'Create account' }).click();
  await confirmEmail(other, owner);
  await expect(other).toHaveURL(link);
  await other.getByTestId('accept-invite').click();

  // 6. It opens on what the agency set up, to check, with what's left for them.
  const check = other.getByTestId('onboarding-setup');
  const otherNext = other.getByTestId('onboarding-setup-next');
  const on = (screen: string) => expect(check).toHaveAttribute('data-screen', screen);
  await expect(other).toHaveURL(new RegExp(`/onboarding/${salon}$`), { timeout: 30_000 });
  await on('check');
  await expect(check.getByRole('heading', { level: 1 })).toHaveText(
    'Check what Handover Agency set up',
  );
  await expect(check).toContainText(`${agency.name} set up Curl Up Salon for you.`);
  await expect(other.getByTestId('onboarding-setup-check')).toContainText('Curl Up Salon');
  await expect(other.getByTestId('onboarding-setup-your-part')).toContainText(
    'Make your booking page, on your own hours',
  );
  await expect(other.getByTestId('onboarding-setup-your-part')).toContainText(
    'Sign in to Stripe, so payments go to your account',
  );

  // Home's card says so too, until they finish.
  await other.goto(`/app/w/${salon}`);
  const card = other.getByTestId('getting-started-setup');
  await expect(card).toContainText('Handover Agency set up your business');
  await card.getByRole('link', { name: 'Check it and finish' }).click();
  await expect(other).toHaveURL(new RegExp(`/onboarding/${salon}$`));
  await on('check');

  // 7. Finish my part: their booking page, made on their own hours as it opens.
  await other.getByTestId('onboarding-setup-finish-part').click();
  await on('booking');
  await expect(other).toHaveURL(new RegExp(`/onboarding/${salon}\\?at=booking&part=owner$`));
  await expect(other.getByTestId('onboarding-setup-counter')).toHaveText(
    '1 of 5 · Your booking page',
  );
  await expect(other.getByTestId('setup-booking-changes')).toBeVisible({ timeout: 30_000 });
  // Back from the first goes back to checking it. The booking page is made now, so their part is what's left.
  await other.getByTestId('onboarding-setup-back').click();
  await on('check');
  await expect(other.getByTestId('onboarding-setup-your-part')).not.toContainText(
    'Make your booking page',
  );
  await other.getByTestId('onboarding-setup-finish-part').click();

  // Payments: Stripe's sign-in comes back to their part.
  await on('paid');
  await expect(other.getByTestId('onboarding-setup-counter')).toHaveText(
    '1 of 4 · Payments and reviews',
  );
  await expect(other.getByTestId('setup-pay-stripe')).toHaveAttribute('aria-checked', 'true');
  await other.getByTestId('setup-pay-connect').click();
  await other.waitForURL(/\/oauth\/fake\/payments\/stripe\/authorize/);
  await other.locator('#account').fill(`acct_handover_${randomUUID().slice(0, 8)}`);
  await other.getByTestId('fake-connect').click();
  await expect(other).toHaveURL(new RegExp(`/onboarding/${salon}\\?at=paid&part=owner$`), {
    timeout: 30_000,
  });
  await on('paid');
  await expect(other.getByTestId('setup-pay-connected')).toContainText('Stripe is connected.');
  await otherNext.click();

  // Stay in the loop, then what the save will change, the test chat and what works.
  await on('loop');
  await expect(other.getByTestId('onboarding-setup-counter')).toHaveText(
    '2 of 4 · Stay in the loop',
  );
  await expect(otherNext).toHaveText('Save');
  await otherNext.click();
  await on('confirm');
  await otherNext.click();
  await on('try');
  await expect(other.getByTestId('ai-setup-try')).toBeVisible({ timeout: 60_000 });
  await other.getByTestId('ai-setup-not-yet').click();
  await on('done');
  await other.getByTestId('onboarding-setup-home').click();
  await expect(other).toHaveURL(new RegExp(`/app/w/${salon}`));
  await expect(other.getByTestId('getting-started-setup')).toHaveCount(0);
  await ctx.close();
});
