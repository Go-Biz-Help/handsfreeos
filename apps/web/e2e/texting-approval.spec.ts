import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { getNumber } from './telephony';

/**
 * Texting approval on its own guided page (the owner, 22 Nov 2026: "the a2p process could also probably be improved
 * so it's easier to follow and understand what's going on"). It says what's coming before it asks anything, the
 * eight questions come in four parts, the example texts are picked by kind ("the ones included didn't always fit or
 * maybe only one did"), and it saves as it goes, so leaving and coming back loses nothing.
 */
test('guided texting approval: what’s coming, four parts, example texts by kind, and carrying on later', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await signUpAndConfirm(page, 'texting-approval');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await getNumber(page, workspaceId);

  // The phone setup's last screen goes straight on to approval, which starts with what's coming.
  await page.getByTestId('phone-setup-approval').click();
  const card = page.getByTestId('texting-approval');
  await expect(card).toHaveAttribute('data-screen', 'start', { timeout: 90_000 });
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/texting$`));
  await expect(card).toContainText('Have these handy');
  await expect(page.getByTestId('guided-step-group')).toHaveText([
    'Your business',
    'Your texts',
    'Your website',
    'Send it',
  ]);
  // Nothing is saved until something is answered.
  await expect(page.getByTestId('guided-saved')).toHaveCount(0);

  await page.getByTestId('texting-approval-start').click();
  await expect(card).toHaveAttribute('data-screen', 'business');
  await expect(page.getByTestId('texting-approval-kicker')).toHaveText(
    'Texting approval · Your business · Question 1 of 8',
  );
  const next = page.getByTestId('a2p-next');

  // Part 1, your business: who the carriers look up, where to find them, who to write to.
  await page.getByLabel('Your EIN').fill('12-3456789');
  const legalName = await page.getByLabel('The name on your IRS letter').inputValue();
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'where');
  // What was answered sits beside the next question.
  const answered = page.getByTestId('guided-step-business');
  await expect(answered).toHaveAttribute('data-state', 'done');
  await expect(answered).toContainText(legalName);
  await page.getByLabel('Your website').fill('https://lonestarhvac.example');
  await page.getByLabel('Street address').fill('4410 Westpark Dr');
  await page.getByLabel('City', { exact: true }).fill('Houston');
  await page.getByLabel('State', { exact: true }).fill('TX');
  await page.getByLabel('ZIP code').fill('77027');
  await next.click();
  await page.getByLabel('Phone', { exact: true }).fill('(713) 555-0161');
  await next.click();

  // Part 2, your texts.
  await expect(page.getByTestId('texting-approval-kicker')).toHaveText(
    'Texting approval · Your texts · Question 4 of 8',
  );
  await page.getByTestId('a2p-sensitive-none').check();
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'samples');

  // Eight to pick from, worded for a home services business, and sorted by what they're for.
  const picker = page.getByTestId('a2p-samples');
  await expect(page.getByTestId('a2p-sample-kind-all')).toHaveText('All 8');
  await expect(picker).toContainText('Worded for your kind of business');
  await expect(picker.getByRole('button', { name: 'Use this' })).toHaveCount(8);
  await page.getByTestId('a2p-sample-kind-payments').click();
  await expect(picker.getByRole('button', { name: 'Use this' })).toHaveCount(2);
  // Use this fills the first empty example, and the row says which one it became.
  await picker.getByRole('button', { name: 'Use this' }).first().click();
  const first = page.locator('#a2p-sample-0');
  await expect(first).toHaveValue(/Lone Star HVAC & Roofing/);
  await expect(picker).toContainText('Example 1');
  await page.getByTestId('a2p-sample-kind-replies').click();
  await picker.getByRole('button', { name: 'Use this' }).first().click();
  await expect(page.locator('#a2p-sample-1')).toHaveValue(/Lone Star HVAC & Roofing/);
  // The general wording is one click away, for a business the kind's words don't fit.
  await page.getByTestId('a2p-samples-general').click();
  await expect(picker).toContainText('General wording.');
  const picked = await first.inputValue();

  // Saved as it goes, and Finish later keeps even what was typed a moment ago: Settings carries on from the same
  // question with the same answers.
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  const typed =
    'Lone Star HVAC & Roofing: your tech is on the way, [First Name]. Reply STOP to stop texts.';
  const second = page.locator('#a2p-sample-1');
  await second.fill(typed);
  await page.getByTestId('guided-leave').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/texting`), {
    timeout: 60_000,
  });
  const carryOn = page.getByTestId('approval-start-go');
  await expect(carryOn).toHaveText('Carry on where you left off');
  await carryOn.click();
  await expect(card).toHaveAttribute('data-screen', 'samples', { timeout: 60_000 });
  await expect(first).toHaveValue(picked);
  await expect(second).toHaveValue(typed);
});
