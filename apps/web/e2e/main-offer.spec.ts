import { expect, test, type Page } from '@playwright/test';
import { WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The business's main offer (docs/main-offer.md), with the scripted stand-in model:
 * - It shows in Settings only once an add-on that uses it (Social Outreach) is on.
 * - The owner builds it a step at a time: the niche from their best customer, the AI's help on a part, the method's
 *   steps, a line put together from the answers, then the score. A part under the bar goes live only with a reason,
 *   kept with the version. Leaving for later keeps the draft.
 * - Changing it makes a draft beside the live version; scored over the bar, it goes live as version 2.
 */
async function turnOnOutreach(page: Page, email: string, workspaceId: string) {
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await page.goto(`/admin/businesses/${workspaceId}`);
  const testing = page.getByTestId('admin-addon-testing');
  await testing.getByTestId('admin-addon-testing-outreach').click();
  await expect(testing).toContainText('they can add it');
  await page.goto(`/app/w/${workspaceId}/add-ons`);
  const card = page.getByTestId('addon-outreach');
  await page.getByTestId('addon-install-outreach').click();
  await expect(card.getByTestId('addon-state')).toHaveText('On', { timeout: 90_000 });
}

test('an owner builds the main offer a step at a time, scores it and goes live, then changes it', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { email } = await signUpAndConfirm(page, 'main-offer-owner');
  const workspaceId = await createBusiness(page, { name: 'Summit Roof Leads' });

  // Not there until an add-on that uses it is on.
  await page.goto(`/app/w/${workspaceId}/settings`);
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  await expect(page.getByTestId('settings-nav').getByText('Main offer')).toHaveCount(0);
  await turnOnOutreach(page, email, workspaceId);
  await page.goto(`/app/w/${workspaceId}/settings`);
  await page.getByTestId('settings-nav').getByRole('link', { name: 'Main offer' }).click();
  await expect(page.getByTestId('main-offer-start')).toBeVisible();
  await page.getByTestId('main-offer-start-building').click();

  const builder = page.getByTestId('offer-builder');
  const step = builder.getByTestId('offer-builder-step');
  const next = builder.getByTestId('offer-continue');
  await expect(step).toHaveAttribute('data-step', 'niche');

  // The niche, from the best customer: the AI's first pick fills Who and moves on.
  await builder.getByLabel('Who’s the best customer you’ve had?').fill('Peak Roofing, 3 crews');
  await builder.getByLabel('What line of work are they in?').fill('Roofing');
  await builder.getByTestId('offer-find-niche').click();
  await expect(builder.getByTestId('offer-niches')).toContainText(
    'Roofing like your best customer',
  );
  await builder.getByTestId('offer-niche-use-0').click();
  await expect(step).toHaveAttribute('data-step', 'who');
  await expect(builder.getByLabel('What line of work are they in?')).toHaveValue('Roofing');
  await builder
    .getByLabel('Their single most painful problem')
    .fill('No steady jobs between storms');
  await next.click();

  // The outcome, written by the AI and picked.
  await expect(step).toHaveAttribute('data-step', 'outcome');
  await builder.getByTestId('offer-outcome-result-ai').click();
  await builder.getByTestId('offer-outcome-result-use-0').click();
  await expect(builder.getByLabel('The result, measurable')).toHaveValue(
    'Option 1 for the result, measurable',
  );
  await next.click();
  await builder.getByLabel('How long does it usually take?').fill('60 days');
  await next.click();

  // The method: the AI's steps, picked whole.
  await expect(step).toHaveAttribute('data-step', 'method');
  await builder.getByTestId('offer-method-ai').click();
  await builder.getByTestId('offer-method-use-0').click();
  await expect(builder.getByTestId('offer-method-step-3')).toHaveValue('Check the results');
  await next.click();

  // Leaving for later keeps the draft, and opening it carries on.
  await builder
    .getByLabel('What do you promise if it doesn’t work?')
    .fill('If you don’t get 10 in 60 days, you don’t pay');
  await builder.getByTestId('offer-finish-later').click();
  await expect(page.getByTestId('main-offer-draft')).toContainText('is changing your offer');
  await page.getByTestId('main-offer-open-draft').click();
  await builder.getByTestId('offer-step-price').click();
  await expect(step).toHaveAttribute('data-step', 'price');
  // A price still to be filled in holds the offer under the bar.
  await builder.getByLabel('What’s your price?').fill('[price] a month');
  await next.click();
  await builder.getByTestId('offer-proof-0').fill('Peak Roofing got 22 inspections in 60 days');
  await next.click();

  // Put together from the answers, then the few words messages carry.
  await expect(step).toHaveAttribute('data-step', 'line');
  await expect(builder.getByLabel('Your offer in one line')).toHaveValue(
    /^We help Roofing like your best customer get/,
  );
  await builder.getByLabel('The outcome, in a few words').fill('10 to 20 booked inspections');
  await builder.getByLabel('The guarantee, in a few words').fill('you only pay for results');
  await expect(builder.getByTestId('offer-preview')).toContainText(
    'open to 10 to 20 booked inspections, where you only pay for results?',
  );
  await next.click();

  // The score: the price is under the bar, so it goes live only with a reason.
  await expect(step).toHaveAttribute('data-step', 'score');
  await builder.getByTestId('offer-score-it').click();
  await expect(builder.getByTestId('offer-score')).toBeVisible();
  await expect(builder.getByTestId('offer-score-fix')).toContainText('Fix the price first');
  await expect(builder.getByTestId('offer-change-weakest')).toHaveText('Change the price');
  await builder.getByTestId('offer-use-anyway').click();
  await page.getByLabel('Why is it going live now?').fill('Pricing after the first call');
  await page.getByTestId('offer-anyway-go').click();

  await expect(page.getByTestId('main-offer-live')).toContainText('Live · version 1');
  await expect(page.getByTestId('main-offer-live')).toContainText('Under the bar');
  await page.getByRole('tab', { name: 'Versions' }).click();
  await expect(page.getByTestId('main-offer-versions')).toContainText(
    'went live anyway: “Pricing after the first call”',
  );

  // Changing it: a draft beside the live version, scored over the bar, goes live as version 2.
  await page.getByRole('tab', { name: 'Live version' }).click();
  await page.getByTestId('main-offer-change').click();
  await expect(step).toHaveAttribute('data-step', 'who');
  await builder.getByTestId('offer-step-price').click();
  await builder.getByLabel('What’s your price?').fill('$2,000 a month');
  await builder.getByTestId('offer-step-score').click();
  await builder.getByTestId('offer-score-it').click();
  await expect(builder.getByTestId('offer-score-clear')).toBeVisible();
  await builder.getByTestId('offer-go-live').click();
  await expect(page.getByTestId('main-offer-live')).toContainText('Live · version 2');
  await expect(page.getByTestId('main-offer-live')).toContainText('Every part 7 or more');
});
