import { expect, test } from '@playwright/test';
import { createBusiness, signUpAndConfirm } from './helpers';
import { getNumber, KNOWLEDGE_SITE } from './telephony';

/**
 * Texting approval's privacy policy and terms, whole (the owner, 22 Nov 2026: "the privacy policy and terms stuff
 * should give them the entire policy and terms based on what they already have so they can copy and paste if they
 * have nothing then create one for them, and the entire policies should be included in the files sent to their web
 * person").
 *
 * The business's website links a privacy policy of its own and has no terms. So the question finds the policy, picks
 * it, reads it and hands it back whole by itself; writes the terms; keeps what it made for when they come back; and
 * the web person's files carry each one whole.
 */
test('texting approval finds a site’s own privacy policy, hands it back whole, and sends it whole', async ({
  page,
}) => {
  test.setTimeout(360_000);
  await signUpAndConfirm(page, 'texting-policy-whole');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC' });
  await getNumber(page, workspaceId);
  await page.getByTestId('phone-setup-approval').click();
  const card = page.getByTestId('texting-approval');
  await page.getByTestId('texting-approval-start').click({ timeout: 90_000 });
  await expect(card).toHaveAttribute('data-screen', 'business', { timeout: 90_000 });
  const next = page.getByTestId('a2p-next');

  // Questions 1 to 6, as a business answers them. Its website is the stand-in site's page for it that links its
  // privacy policy in the footer, the way a real site does.
  await page.getByLabel('Your EIN').fill('12-3456789');
  const legalName = await page.getByLabel('The name on your IRS letter').inputValue();
  await next.click();
  await page
    .getByLabel('Your website')
    .fill(`${KNOWLEDGE_SITE}/with-policy/${encodeURIComponent(legalName)}`);
  await page.getByLabel('Street address').fill('4410 Westpark Dr');
  await page.getByLabel('City', { exact: true }).fill('Houston');
  await page.getByLabel('State', { exact: true }).fill('TX');
  await page.getByLabel('ZIP code').fill('77027');
  await next.click();
  await page.getByLabel('Phone', { exact: true }).fill('(713) 555-0161');
  await next.click();
  await page.getByTestId('a2p-sensitive-none').check();
  await next.click();
  await page.getByTestId('a2p-suggestion-0').click();
  await page.getByTestId('a2p-suggestion-1').click();
  await expect(page.locator('#a2p-sample-1')).not.toHaveValue('');
  await next.click();
  await page.getByTestId('optin-own_site').click();
  const formLink = page.getByTestId('optin-form-link');
  await expect(formLink).toBeVisible({ timeout: 60_000 });
  const formUrl = (await formLink.getAttribute('href'))!;
  await page
    .getByTestId('a2p-optin-url')
    .fill(`${KNOWLEDGE_SITE}/with-form?src=${encodeURIComponent(`${formUrl}?embed=1`)}`);
  await next.click();

  // Question 7. Nobody picked anything: the look at their website found the privacy policy and picked it, found no
  // terms and left ours, and says so.
  await expect(card).toHaveAttribute('data-screen', 'policy');
  const found = page.getByTestId('policy-found');
  await expect(found).toContainText('We found your privacy policy on 127.0.0.1:4190', {
    timeout: 60_000,
  });
  await expect(found).toContainText('We didn’t find terms there, so we wrote those for you.');
  await expect(page.getByTestId('policy-own')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByLabel('Where your privacy policy is')).toHaveValue(
    `${KNOWLEDGE_SITE}/privacy`,
  );
  await expect(page.getByTestId('terms-hosted')).toHaveAttribute('aria-checked', 'true');

  // Their own policy is read and handed back whole without a press: its own words, with the part about texts added.
  const result = page.getByTestId('policy-update-privacy-result');
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toContainText('Lone Star HVAC collects your name, phone number');
  await expect(result).toContainText('No mobile information will be shared with third parties');
  await expect(result.getByRole('button', { name: 'Copy all of it' })).toBeVisible();
  const run = page.getByTestId('policy-update-privacy-run');
  await expect(run).toHaveText('Read it again');
  // The terms are ours, shown whole, with all of them to copy.
  const terms = page.getByTestId('terms-ours');
  await expect(terms.getByRole('button', { name: 'Copy all of it' })).toBeVisible();
  await expect(terms).toContainText('STOP');

  // Leaving and coming back: the same picks, and the policy as it was handed back, kept rather than made again. The
  // look doesn't speak twice, because the picks are the business's now.
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  await page.getByTestId('guided-leave').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/texting`), {
    timeout: 60_000,
  });
  await page.getByTestId('approval-start-go').click();
  await expect(card).toHaveAttribute('data-screen', 'policy', { timeout: 60_000 });
  await expect(page.getByTestId('policy-own')).toHaveAttribute('aria-checked', 'true');
  await expect(result).toBeVisible({ timeout: 60_000 });
  await expect(result).toContainText('Lone Star HVAC collects your name, phone number');
  await expect(run).toHaveText('Read it again');
  await expect(found).toHaveCount(0);

  // The web person's files, from Before it goes: the privacy policy is the business's own, whole, with the page to
  // replace; the terms are ours, whole. Each in a file of its own.
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await page
    .getByTestId('registration-web-person')
    .getByTestId('web-person-open')
    .click({ timeout: 90_000 });
  const dialog = page.getByTestId('web-person-dialog');
  await dialog.getByTestId('web-person-fix-form').getByRole('checkbox').uncheck();
  await dialog.getByTestId('web-person-fix-chat').getByRole('checkbox').uncheck();
  await dialog.getByTestId('web-person-fix-policy').getByRole('checkbox').check();
  const privacyFile = dialog.getByTestId('web-person-show-policy');
  await expect(privacyFile).toHaveText('privacy-policy.txt', { timeout: 60_000 });
  await privacyFile.click();
  const privacyText = dialog.getByTestId('web-person-file-policy');
  await expect(privacyText).toContainText(
    `Replace everything on the privacy policy page at ${KNOWLEDGE_SITE}/privacy`,
  );
  await expect(privacyText).toContainText('Lone Star HVAC collects your name, phone number');
  const termsFile = dialog.getByTestId('web-person-show-policy-2');
  await expect(termsFile).toHaveText('terms.txt');
  await termsFile.click();
  await expect(dialog.getByTestId('web-person-file-policy-2')).toContainText('The whole terms');
});
