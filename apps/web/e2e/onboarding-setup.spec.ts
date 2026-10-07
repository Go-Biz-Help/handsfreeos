import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signUpAndConfirm, uniqueEmail, waitForMail } from './helpers';

/**
 * Quick setup for a new business on the web (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §7): straight
 * after signing up, one question per screen with the summary beside it. The first screen makes the business, its
 * address setting the time zone. The goal invites the team. "About your business" fills in the AI part too, and a
 * business whose customers book a time has its booking page made as that screen opens. The number stop is Settings
 * → Texting & calls, looking near the address. Finish later goes Home, whose card carries on where they left off;
 * Stripe's sign-in comes straight back. The AI teammate's screens follow, "Stay in the loop" saves it all, the test
 * chat turns it on with training wheels, and the last screen says what already works. Home has nothing left to
 * carry on.
 */
test('a new owner sets up the business one question at a time, carries on later, and finishes', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signUpAndConfirm(page, 'onboard-setup');
  await expect(page).toHaveURL(/\/onboarding$/);
  const setup = page.getByTestId('onboarding-setup');
  const counter = page.getByTestId('onboarding-setup-counter');
  const summary = page.getByTestId('onboarding-setup-summary');
  const next = page.getByTestId('onboarding-setup-next');
  const at = (screen: string) => expect(setup).toHaveAttribute('data-screen', screen);

  // 1. Your business: what's missing is said where it's missing.
  await at('business');
  await expect(counter).toHaveText('2 of 12 · Your business');
  await next.click();
  await expect(setup).toContainText('Name your business.');
  await expect(setup).toContainText('Pick what you do');
  await page.getByTestId('setup-business-name').fill('Bella Hair Studio');
  await page.getByTestId('setup-kind-button-beauty').click();
  await page.getByTestId('setup-kind-hair_salon').click();
  await page.getByTestId('setup-line1').fill('1600 Pearl St');
  await page.getByTestId('setup-city').fill('Boulder');
  await page.getByTestId('setup-state').selectOption('CO');
  await page.getByTestId('setup-postal-code').fill('80302');
  // The address sets the time zone, and the summary follows what's typed.
  await expect(page.getByTestId('setup-time-zone')).toContainText(
    'Mountain time, from your address.',
  );
  await expect(summary).toContainText(
    'Bella Hair Studio: Hair salon in Boulder, Colorado, on Mountain time.',
  );
  await page.getByTestId('ai-setup-no-website').click();
  await next.click();

  // 2. Your goal, on the business's own setup page. A hair salon books times, so the booking page is a stop now.
  await expect(page).toHaveURL(/\/onboarding\/[0-9a-f-]{36}\?at=goal$/);
  const workspaceId = /\/onboarding\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  await at('goal');
  await expect(counter).toHaveText('3 of 13 · Your goal');
  await expect(page.getByTestId('onboarding-setup-carry-on')).toHaveCount(0);
  await page.getByTestId('setup-goal-booked').click();
  // Anyone else gets an invitation from here.
  await expect(page.getByTestId('setup-invites')).toHaveCount(0);
  await page.getByTestId('ai-setup-team-size-small').click();
  const teammate = uniqueEmail('onboard-setup-mate');
  await page.getByTestId('setup-invite-0').fill(teammate);
  const invited = Date.now();
  await next.click();
  await waitForMail(teammate, 'invited you to Bella Hair Studio', { after: invited });

  // 3. About your business: what it does, and what customers book, with a price and how long.
  await at('about');
  await expect(page.getByTestId('ai-setup-books-time-yes')).toHaveAttribute('aria-checked', 'true');
  await next.click();
  await expect(setup).toContainText('Say what your business does in a sentence or two');
  await expect(setup).toContainText(
    'Add what customers book, so your booking page has something to book.',
  );
  await page
    .getByTestId('ai-setup-description')
    .fill('Cuts, color and styling for everyone in Boulder.');
  await page.getByTestId('ai-setup-add-service').click();
  await page.getByTestId('ai-setup-service-0-name').fill('Haircut');
  await page.getByTestId('ai-setup-service-0-price').fill('45');
  await page.getByTestId('ai-setup-service-0-minutes').selectOption('45');
  await next.click();

  // 4. The hours, picked for a hair salon, kept as they are.
  await at('hours');
  await next.click();

  // 5. Where customers are: a spreadsheet opens the import right here; "Nowhere yet" adds them as they come.
  await at('customers');
  await page.getByTestId('setup-customers-sheet').click();
  await expect(page.getByTestId('import-step-upload')).toBeVisible();
  await page.getByTestId('setup-customers-none').click();
  await expect(page.getByTestId('import-step-upload')).toHaveCount(0);
  await next.click();

  // 6. The booking page, made from the service and the hours as the screen opens.
  await at('booking');
  await expect(page.getByTestId('setup-booking-changes')).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByTestId('setup-booking-link').getByRole('link', { name: 'Open it' }),
  ).toHaveAttribute('href', /\/book\/[a-z0-9-]+$/);
  await next.click();

  // 7. The business number: with an EIN it's a local one, and numbers near the address show straight away.
  await at('number');
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}\\?at=number$`));
  await page.getByTestId('setup-ein-yes').click();
  await expect(page.getByTestId('number-results')).toContainText('Boulder', { timeout: 60_000 });
  await next.click();
  await at('paid');

  // Finish later: Home's card carries on where they left off.
  await page.getByTestId('onboarding-setup-finish-later').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  await page.getByTestId('tour-skip').click();
  const card = page.getByTestId('getting-started-setup');
  await expect(card).toContainText('Finish setting up your business');
  await card.getByRole('link', { name: 'Carry on' }).click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}$`));
  await at('paid');
  await expect(page.getByTestId('onboarding-setup-carry-on')).toContainText(
    'Carry on where you left off',
  );

  // 8. Payments: Stripe's sign-in comes straight back here, connected; and the review link.
  await page.getByTestId('setup-pay-stripe').click();
  await page.getByTestId('setup-pay-connect').click();
  await page.waitForURL(/\/oauth\/fake\/payments\/stripe\/authorize/);
  await page.locator('#account').fill(`acct_setup_${randomUUID().slice(0, 8)}`);
  await page.getByTestId('fake-connect').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}\\?at=paid$`), {
    timeout: 30_000,
  });
  await at('paid');
  await expect(page.getByTestId('setup-pay-connected')).toContainText('Stripe is connected.');
  await expect(page.getByTestId('setup-pay-stripe')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('setup-review-link').fill('https://g.page/r/bella-hair-studio/review');
  await next.click();

  // 9. The AI teammate's screens, as the AI quick setup asks them: its name, and the rest as picked.
  await at('jobs');
  await expect(counter).toHaveText('10 of 13 · Your AI teammate');
  for (let i = 0; i < 8 && (await setup.getAttribute('data-screen')) !== 'loop'; i++) {
    const screen = (await setup.getAttribute('data-screen'))!;
    if (screen === 'meet') await page.getByTestId('ai-setup-name').fill('Max');
    await next.click();
    await expect(setup).not.toHaveAttribute('data-screen', screen);
  }

  // 10. Stay in the loop: Save sets it all up, and the test chat comes next.
  await at('loop');
  await expect(next).toHaveText('Save');
  await next.click();
  await at('try');
  await expect(page.getByTestId('ai-setup-try')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('ai-setup-turn-on').click();
  await expect(
    page.getByText('Turned on. Max starts with training wheels: every message waits for your OK.'),
  ).toBeVisible();

  // 11. What already works, then Home, with nothing left to carry on.
  await at('done');
  await expect(page.getByTestId('onboarding-setup-done')).toContainText('Bella Hair Studio');
  await page.getByTestId('onboarding-setup-home').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await expect(page.getByTestId('getting-started-setup')).toHaveCount(0);
  await expect(page.getByTestId('getting-started-payments')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('getting-started-customers')).toHaveAttribute('data-state', 'done');

  // Opened again, it's the last screen.
  await page.goto(`/onboarding/${workspaceId}`);
  await at('done');
});
