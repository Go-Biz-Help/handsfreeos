import { expect, test, type Locator, type Page } from '@playwright/test';
import { consentToAssistant } from './booking-helpers';
import { createBusiness, PASSWORD, signUpAndConfirm } from './helpers';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const panel = (page: Page): Locator => page.getByTestId('assistant-panel');

/** The newest answer, once it has finished streaming in. */
async function lastAnswer(page: Page): Promise<Locator> {
  const answer = panel(page).getByTestId('assistant-message').last();
  await expect(answer).toHaveAttribute('data-state', 'done');
  return answer;
}

/** Sends a question with Return and waits until its answer has finished streaming in. */
async function ask(page: Page, question: string): Promise<Locator> {
  const box = panel(page).getByRole('textbox', { name: 'Message the Assistant' });
  await box.fill(question);
  await box.press('Enter');
  await expect(panel(page).getByTestId('assistant-question').last()).toHaveText(question);
  return lastAnswer(page);
}

/** A bearer token from Supabase's password sign-in, with the publishable key the web app holds. */
async function signInForApi(email: string): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error('The Supabase URL and publishable key come from .env.local (pnpm env:local).');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`Signing in for the API failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Setting the business up by asking (M12), against the scripted stand-in model: the question this milestone came
 * from — "How do I create a calendar?" — is answered with an offer to do it rather than a pointer to Settings; the
 * calendar it proposes changes nothing until Confirm; and afterwards it really is on the Calendars screen. Then the
 * other half: Stripe, which only the person can connect, comes back as steps and a link, not as a refusal.
 */
test('assistant settings: a calendar made by asking, and Stripe handed back with steps', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await signUpAndConfirm(page, 'assistant-settings');
  const workspaceId = await createBusiness(page, { name: 'Setup HVAC' });
  await consentToAssistant(owner.email);
  const token = await signInForApi(owner.email);
  const calendars = async (): Promise<string[]> => {
    const res = await fetch(`${API_URL}/v1/queries/calendar.list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId }),
    });
    if (!res.ok) throw new Error(`calendar.list: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { items: { name: string }[] };
    return body.items.map((c) => c.name);
  };

  await page.getByTestId('ask-assistant').click();
  await expect(panel(page)).toBeVisible();

  // It offers to do it, rather than sending anyone to a settings screen.
  const offered = await ask(page, 'How do I create a calendar?');
  await expect(offered).toContainText('set one up for you');

  // The proposal is a card, and nothing exists until it is confirmed.
  await ask(page, 'Create a calendar called Duct cleaning');
  const card = panel(page).getByTestId('assistant-card-confirm').last();
  await expect(card).toContainText('Set up Duct cleaning');
  await expect(card.getByTestId('assistant-confirm')).toHaveText('Set it up');
  expect(await calendars()).not.toContain('Duct cleaning');

  await card.getByTestId('assistant-confirm').click();
  await expect(card).toContainText('Duct cleaning is set up');
  expect(await calendars()).toContain('Duct cleaning');

  // What only the person can do comes back as steps and a link, not as "you can't".
  const stripe = await ask(page, 'How do I connect Stripe?');
  await expect(stripe).toContainText('yours to do');
  const steps = panel(page).getByTestId('assistant-card-list').last();
  await expect(steps).toContainText('Settings → Payments');

  // And it really is there on the screen the business uses.
  await page.goto(`/app/w/${workspaceId}/settings/calendars`);
  await expect(page.getByText('Duct cleaning').first()).toBeVisible();
});
