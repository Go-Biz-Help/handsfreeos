import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Getting started (HANDSFREEOS_ONBOARDING_IMPLEMENTATION_PLAN.md §6). On Home, a new business's owner sees the
 * business's steps, the number first, and the guided setup they started (onboarding-setup.spec.ts goes through
 * it) to carry on; skips a step and takes it back; opens the phone app's links; hides the guide and gets it back
 * from Get help. The guided setup's answers put the steps in order, and the setup wizard walks them.
 */
test('a new owner works through Getting started on Home, hides it, and brings it back', async ({
  page,
}) => {
  await signUpAndConfirm(page, 'guide-owner');
  await createBusiness(page, { name: 'Guide Test Plumbing' });

  const guide = page.getByTestId('getting-started');
  await expect(guide).toBeVisible();
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 9 done');
  await expect(guide.getByText('The basics')).toBeVisible();
  await expect(guide.getByText('When you’re ready')).toBeVisible();
  // They left the guided setup after its first screen, so the card says to carry on.
  const setup = page.getByTestId('getting-started-setup');
  await expect(setup).toContainText('Finish setting up your business');
  await expect(setup.getByRole('link', { name: 'Carry on' })).toHaveAttribute(
    'href',
    /\/onboarding\/[0-9a-f-]{36}$/,
  );

  // The business number comes first.
  const number = page.getByTestId('getting-started-number');
  await expect(number).toContainText('Business number & texting');
  await expect(number.getByRole('link', { name: 'Get a number' })).toHaveAttribute(
    'href',
    /\/onboarding\/[0-9a-f-]{36}\/setup\/number$/,
  );

  // Skip it: it says so, drops off the count, and Undo takes it back.
  await number.getByRole('button', { name: 'Skip' }).click();
  await expect(number).toHaveAttribute('data-state', 'skipped');
  await expect(number).toContainText('Skipped for now.');
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 8 done');
  await number.getByRole('button', { name: 'Undo' }).click();
  await expect(number).toHaveAttribute('data-state', 'todo');
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 9 done');

  // The phone app's step opens the test links.
  await page
    .getByTestId('getting-started-app')
    .getByRole('button', { name: 'Get the links' })
    .click();
  const links = page.getByTestId('phone-app-links');
  await expect(links.getByRole('link', { name: 'Open TestFlight' })).toHaveAttribute(
    'href',
    'https://testflight.apple.com/join/GBEM8rJU',
  );
  await expect(links.getByRole('link', { name: 'Open Google Play testing' })).toBeVisible();
  await page.keyboard.press('Escape');

  // The card offers the tour. Escape ends it, which counts as taken: the offer goes.
  await page
    .getByTestId('getting-started-tour')
    .getByRole('button', { name: 'Take the tour' })
    .click();
  const tour = page.getByTestId('tour');
  await expect(tour).toHaveAttribute('data-stop', 'home');
  await expect(tour).toContainText('1 of 5');
  await page.keyboard.press('Escape');
  await expect(tour).toHaveCount(0);
  await expect(page.getByTestId('getting-started-tour')).toHaveCount(0);
  // Get help still has it.
  await page.getByTestId('get-help').click();
  await page.getByTestId('get-help-tour').click();
  await expect(tour).toHaveAttribute('data-stop', 'home');
  await page.getByTestId('tour-skip').click();
  await expect(tour).toHaveCount(0);

  // Hide it: it goes, the toast says where it is, and Get help carries a dot until it's back.
  await page.getByTestId('getting-started-hide').click();
  await expect(page.getByText('Getting started is hidden.', { exact: false })).toBeVisible();
  await expect(guide).toHaveCount(0);
  await expect(page.getByTestId('action-center-intro')).toBeVisible();
  await expect(page.getByTestId('get-help-dot')).toBeVisible();

  await page.getByTestId('get-help').click();
  await page.getByTestId('get-help-guide').click();
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await expect(page.getByTestId('get-help-dot')).toHaveCount(0);

  // "Ask us for help" is still one press away.
  await page.getByTestId('get-help').click();
  await page.getByTestId('get-help-ask').click();
  await expect(page.getByRole('dialog', { name: 'Ask us for help' })).toBeVisible();
});

test('the guided setup’s answers put the steps in order, and the wizard walks them', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndConfirm(page, 'guide-questions');
  const workspaceId = await createBusiness(page, { name: 'Questions Test Roofing', setup: true });
  const at = (screen: string) =>
    expect(page.getByTestId('onboarding-setup')).toHaveAttribute('data-screen', screen);
  const next = page.getByTestId('onboarding-setup-next');

  // Getting paid comes first, it's just them, and their customers are in GoHighLevel.
  await page.getByTestId('setup-goal-paid').click();
  await expect(page.getByTestId('ai-setup-team-size-solo')).toHaveAttribute('aria-checked', 'true');
  await next.click();
  await at('about');
  await page.getByTestId('ai-setup-description').fill('Roof repairs and new roofs in Chicago.');
  await next.click();
  await at('hours');
  await next.click();
  await at('look');
  await next.click();
  await at('customers');
  await page.getByTestId('setup-customers-ghl').click();
  // GoHighLevel's private token is pasted right here.
  await expect(page.getByTestId('migration-connect')).toBeVisible();
  await next.click();
  await at('number');

  // Finish later: out of setup, the tour, five stops down the menu, Back and Next, then Done.
  await page.getByTestId('onboarding-setup-finish-later').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}`));
  const tour = page.getByTestId('tour');
  const stops: string[] = [];
  await expect(tour).toBeVisible();
  for (let i = 0; i < 5; i++) {
    stops.push((await tour.getAttribute('data-stop'))!);
    await expect(tour).toContainText(`${i + 1} of 5`);
    if (i === 1) {
      await page.getByTestId('tour-back').click();
      await expect(tour).toHaveAttribute('data-stop', 'home');
      await page.getByTestId('tour-next').click();
    }
    if (i < 4) await page.getByTestId('tour-next').click();
  }
  expect(stops).toEqual(['home', 'inbox', 'pipeline', 'calendar', 'ask']);
  await expect(tour).toContainText('Ask HandsFreeOS anything');
  await page.getByTestId('tour-done').click();
  await expect(tour).toHaveCount(0);
  await expect(page.getByTestId('getting-started-tour')).toHaveCount(0);

  // Home follows the answers: payments is a must-do, second, and there's no team step.
  const rows = page.getByTestId('getting-started').locator('li[data-state]');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'getting-started-payments');
  await expect(page.getByTestId('getting-started-team')).toHaveCount(0);

  // The wizard, in the answers' order: the number first, then payments. Invite your team isn't anywhere.
  await page
    .getByTestId('getting-started-number')
    .getByRole('link', { name: 'Get a number' })
    .click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/setup/number$`));
  const rail = page.getByTestId('setup-rail');
  await expect(rail.getByRole('link')).toHaveCount(5);
  await expect(rail.getByRole('link').nth(1)).toHaveAttribute('data-testid', 'setup-rail-payments');
  await expect(rail).not.toContainText('Invite your team');
  await expect(page.getByRole('heading', { name: 'Get your business number' })).toBeVisible();
  // Whether there's an EIN decides the kind of number; the search below is Settings → Texting & calls.
  await expect(page.getByTestId('setup-ein-yes')).toBeVisible();
  await expect(page.getByTestId('texting-setup')).toBeVisible();

  // Skip it for now: on to payments, and the side says so.
  await page.getByTestId('setup-skip').click();
  await expect(page).toHaveURL(new RegExp(`/setup/payments$`));
  await expect(page.getByTestId('setup-rail-number')).toHaveAttribute('data-state', 'skipped');
  await expect(page.getByText('You said getting paid comes first.')).toBeVisible();
  await expect(page.getByTestId('setup-payments-connect')).toHaveText('Connect Stripe');
  await page.getByTestId('setup-payments-square').click();
  await expect(page.getByTestId('setup-payments-connect')).toHaveText('Connect Square');
  // Back goes to the number; the rail goes anywhere.
  await page.getByTestId('setup-back').click();
  await expect(page).toHaveURL(new RegExp(`/setup/number$`));
  await page.getByTestId('setup-rail-customers').click();

  // Customers: GoHighLevel fits the answer; adding them as they come finishes the step.
  await expect(page).toHaveURL(new RegExp(`/setup/customers$`));
  await expect(page.getByText('You said your customers are in GoHighLevel.')).toBeVisible();
  await expect(page.getByTestId('setup-customers-migrate')).toContainText('Fits your answer');
  await expect(page.getByTestId('migration-connect')).toBeVisible();
  await page.getByTestId('setup-customers-asYouGo').click();
  await page.getByTestId('setup-customers-as-you-go').click();
  await expect(page.getByTestId('setup-done')).toBeVisible();
  await expect(page.getByTestId('setup-rail-customers')).toHaveAttribute('data-state', 'done');
  await page.getByTestId('setup-continue').click();

  // The calendar needs a service before there's something to book.
  await expect(page).toHaveURL(new RegExp(`/setup/calendar$`));
  await expect(page.getByTestId('setup-calendar-make')).toBeDisabled();
  await expect(page.getByTestId('booking-site')).toBeVisible();
  await page.getByTestId('setup-skip').click();

  // The AI teammate, last: quick setup, with the presets a click away. Skipping the last step goes Home.
  await expect(page).toHaveURL(new RegExp(`/setup/ai$`));
  await expect(page.getByTestId('ai-setup')).toHaveAttribute('data-step', 'business');
  await page.getByTestId('ai-setup-myself').click();
  await expect(page).toHaveURL(new RegExp(`/setup/ai\\?myself=1$`));
  await expect(page.getByTestId('teammate-preset-picker')).toBeVisible();
  await page.getByTestId('setup-skip').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));
  // The tour was taken already.
  await expect(page.getByTestId('tour')).toHaveCount(0);

  // Home follows the answers and the wizard: payments is second; customers are done; three steps were skipped;
  // and the guided setup is still there to finish.
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'getting-started-payments');
  await expect(page.getByTestId('getting-started-customers')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('getting-started-count')).toHaveText('1 of 5 done');
  await expect(page.getByTestId('getting-started-setup')).toContainText(
    'Finish setting up your business',
  );
});

test('a sign-in started in the wizard comes back to it', async ({ page }) => {
  await signUpAndConfirm(page, 'guide-payments');
  const workspaceId = await createBusiness(page, { name: 'Wizard Pay Plumbing' });
  await page.goto(`/onboarding/${workspaceId}/setup/payments`);
  await expect(page.getByRole('heading', { name: 'Connect how you get paid' })).toBeVisible();
  // Not a must-do without "Getting paid": it's among the later steps, and Continue goes Home.
  await expect(page.getByTestId('setup-rail-payments')).toHaveCount(0);

  // Stripe's sign-in (the stand-in) goes back to the wizard's step, not to Settings → Payments.
  await page.getByTestId('setup-payments-connect').click();
  await page.waitForURL(/\/oauth\/fake\/payments\/stripe\/authorize/);
  await page.locator('#account').fill(`acct_wizard_${randomUUID().slice(0, 8)}`);
  await page.getByTestId('fake-connect').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/setup/payments$`));
  await expect(
    page.getByText('Connected. Money from HandsFreeOS goes straight into it.'),
  ).toBeVisible();
  await expect(page.getByTestId('setup-done')).toBeVisible();
  await page.getByTestId('setup-continue').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));
  await expect(page.getByTestId('getting-started-payments')).toHaveAttribute('data-state', 'done');
  // The tour, which they haven't taken yet: skipped.
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour')).toHaveCount(0);
});

test('an owner turns Getting started off for everyone, and back on', async ({ page }) => {
  await signUpAndConfirm(page, 'guide-off');
  const workspaceId = await createBusiness(page, { name: 'Guide Off Plumbing' });
  await expect(page.getByTestId('getting-started')).toBeVisible();

  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  const toggle = page.getByTestId('getting-started-enabled');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(
    page.getByText('Getting started is off for everyone in this business.'),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

  // Home has no guide, Get help is only the form, and the setup wizard goes Home.
  await page.goto(`/app/w/${workspaceId}`);
  await expect(page.getByTestId('action-center-intro')).toBeVisible();
  await expect(page.getByTestId('getting-started')).toHaveCount(0);
  await page.getByTestId('get-help').click();
  await expect(page.getByRole('dialog', { name: 'Ask us for help' })).toBeVisible();
  await page.goto(`/onboarding/${workspaceId}/setup/number`);
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));

  // Back on, it's as it was.
  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  await page.getByTestId('getting-started-enabled').click();
  await expect(page.getByTestId('getting-started-enabled')).toHaveAttribute('aria-checked', 'true');
  await page.goto(`/app/w/${workspaceId}`);
  await expect(page.getByTestId('getting-started-count')).toHaveText('0 of 9 done');
});
