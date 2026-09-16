import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The Assistant's consent step on the web (M10), against the scripted stand-in model: it shows before the first
 * question with the canvas's words; Not now closes the panel and it asks again next time; OK, continue keeps the OK
 * with the account and the panel is ready; an OK given elsewhere (the phone) while the page was open is seen when the
 * panel opens; and the worker's refusal (the OK gone since the page loaded) brings the step back, with the question
 * asked once the person says OK.
 */

const panel = (page: Page) => page.getByTestId('assistant-panel');
const step = (page: Page) => panel(page).getByTestId('assistant-consent');

async function needed(email: string): Promise<boolean> {
  const { token } = await signInOwner(email);
  const me = await api<{ assistantConsent: { needed: boolean } }>(
    token,
    'queries',
    'account.me',
    {},
  );
  return me.assistantConsent.needed;
}

test('asks for the OK before the first question; Not now asks again; OK keeps it', async ({
  page,
}) => {
  const owner = await signUpAndConfirm(page, 'consent-web');
  await createBusiness(page, { name: 'Consent HVAC' });

  await page.getByTestId('ask-assistant').click();
  await expect(
    step(page).getByRole('heading', { name: 'The Assistant uses Anthropic’s Claude' }),
  ).toBeVisible();
  await expect(step(page)).toContainText(
    'What you ask about is sent to Anthropic’s Claude to answer you.',
  );
  await expect(step(page)).toContainText(
    'Nothing goes to a customer, and nothing is booked or changed, until you say OK.',
  );
  await expect(step(page)).toContainText('Anthropic is the company that makes Claude.');
  await expect(panel(page).getByRole('textbox', { name: 'Message the Assistant' })).toHaveCount(0);

  await step(page).getByRole('button', { name: 'Not now' }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await needed(owner.email)).toBe(true);
  await page.getByTestId('ask-assistant').click();
  await expect(step(page)).toBeVisible();

  await page.getByTestId('assistant-consent-ok').click();
  await expect(step(page)).toHaveCount(0);
  await expect(panel(page).getByTestId('assistant-empty')).toContainText('What can I help with?');
  expect(await needed(owner.email)).toBe(false);
  // Kept: after a reload it doesn't ask again.
  await page.reload();
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page).getByTestId('assistant-empty')).toBeVisible();
  await expect(step(page)).toHaveCount(0);
});

test('an OK from the phone is seen when the panel opens; a refusal brings the step back and asks after the OK', async ({
  page,
}) => {
  const owner = await signUpAndConfirm(page, 'consent-elsewhere');
  await createBusiness(page, { name: 'Consent Elsewhere HVAC' });
  const { token } = await signInOwner(owner.email);

  // Said OK on the phone while this page was open.
  const { ASSISTANT_CONSENT_VERSION } = await import('@hfos/core');
  await api(token, 'commands', 'assistant.consent', { version: ASSISTANT_CONSENT_VERSION });
  await page.getByTestId('ask-assistant').click();
  await expect(panel(page).getByTestId('assistant-empty')).toBeVisible();
  await expect(step(page)).toHaveCount(0);

  // The OK is gone (a new wording, say) while the page still thinks it's there: the worker refuses the question,
  // and the step shows instead of an error.
  await api(token, 'commands', 'user.update_profile', { settings: { assistantConsent: {} } });
  const box = panel(page).getByRole('textbox', { name: 'Message the Assistant' });
  await box.fill('What needs attention?');
  await box.press('Enter');
  await expect(step(page)).toBeVisible();
  await expect(panel(page).getByTestId('assistant-question')).toHaveCount(0);
  await page.getByTestId('assistant-consent-ok').click();
  await expect(panel(page).getByTestId('assistant-question').last()).toHaveText(
    'What needs attention?',
  );
  await expect(panel(page).getByTestId('assistant-message').last()).toHaveAttribute(
    'data-state',
    'done',
  );
});
