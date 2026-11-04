import { expect, test, type Page } from '@playwright/test';
import { WORKER, consentToAssistant } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The demo player (lib/demo): HandsFreeOS staff open it with `?demo`, pick a scene, and each press of Space plays its
 * next step on the real screens with made-up people, messages and campaigns. Nobody else gets it, and Exit leaves
 * the business as it was: nothing a scene shows was ever saved.
 */

// A presenter's screen: the app beside the player's panel still has room for the customer's details.
test.use({ viewport: { width: 1680, height: 960 } });

const director = (page: Page) => page.getByTestId('demo-director');

/** Plays `count` steps with Space, each to its end, with no step reporting a problem. */
async function play(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Space');
    await expect(page.getByTestId('demo-steps').locator('li').nth(i)).toContainText('✓');
    await expect(page.getByTestId('demo-next')).not.toHaveAttribute('aria-busy', 'true', {
      timeout: 40_000,
    });
    await expect(director(page).getByRole('alert')).toHaveCount(0);
  }
  await expect(page.getByTestId('demo-scene-done')).toBeVisible();
}

/** Picks a scene and waits until it has loaded, so the first Space plays its first step. */
async function pick(page: Page, scene: string, firstStep: string): Promise<void> {
  await page.getByTestId(`demo-scene-${scene}`).click();
  await expect(page.getByTestId('demo-next-step')).toContainText(firstStep);
  await expect(page.getByTestId('demo-next')).not.toHaveAttribute('aria-busy', 'true');
}

async function staffBusiness(page: Page, label: string): Promise<string> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: 'Summit Plumbing & Drain' });
  // Not staff yet: `?demo` does nothing.
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(director(page)).toHaveCount(0);
  const made = await page.request.post(`${WORKER}/test/staff/make-admin`, { data: { email } });
  expect(((await made.json()) as { made: number }).made).toBe(1);
  await consentToAssistant(email);
  return workspaceId;
}

test('demo player: a new lead texts, the AI teammate answers and books on your OK', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspaceId = await staffBusiness(page, 'demo-lead');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();
  await page.getByTestId('demo-scene-lead-text').click();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open the Inbox');

  await play(page, 8);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  const thread = page.getByTestId('conversation');
  await expect(
    thread.getByText(/Hi Dana, this is \S+ with Summit Plumbing & Drain\./),
  ).toBeVisible();
  await expect(thread.getByText('You’re all set for tomorrow at 9:00 AM, Dana.')).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Water heater repair')).toBeVisible();
  await expect(page.getByTestId('draft-card')).toHaveCount(0);

  // Exit: the made-up conversation was never there.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Dana Whitfield')).toHaveCount(0);
});

test('demo player: Ask HandsFreeOS builds a text campaign you review and approve', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspaceId = await staffBusiness(page, 'demo-campaign');
  await page.goto(`/app/w/${workspaceId}?demo`);
  await page.getByTestId('demo-scene-text-campaign').click();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open Ask HandsFreeOS');

  await play(page, 7);
  await expect(page).toHaveURL(/\/campaigns\/de300000-/);
  await expect(page.getByTestId('campaign-status')).toHaveText(/Sending/);
  await expect(page.getByTestId('campaign-view')).toContainText('1 of 17 sent');
  await expect(page.getByTestId('assistant-panel')).toContainText(
    'Text our past customers about a fall tune-up, $89 this month.',
  );

  // The campaign was never made: Campaigns lists nothing once the scene is gone.
  await page.getByTestId('demo-exit').click();
  await page.goto(`/app/w/${workspaceId}/campaigns`);
  await expect(page.getByText('Fall tune-up')).toHaveCount(0);
});

test('demo player: calls, website chats, hand-offs to you, and a quote that becomes an invoice', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const workspaceId = await staffBusiness(page, 'demo-teammate');
  await page.goto(`/app/w/${workspaceId}/inbox?demo`);
  await expect(director(page)).toBeVisible();
  const thread = page.getByTestId('conversation');

  // Scene 2: the AI teammate answers a call, books it and texts the details; you open what was said.
  await pick(page, 'busy-call', 'Open the Inbox');
  await play(page, 6);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(thread.getByText(/at 10:00 AM for the leak under your kitchen sink/)).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Kitchen sink leak')).toBeVisible();

  // Scene 3: a website visitor gets answered, gives her name and is booked, all in the chat.
  await pick(page, 'website-chat', 'Open the Inbox');
  await play(page, 7);
  await expect(
    thread.getByText('You’re all set for tomorrow at 8:00 AM, Priya.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Drain cleaning')).toBeVisible();

  // Scene 4: a price it doesn't know goes to you; you take it and answer yourself.
  await pick(page, 'price-question', 'Open the Inbox');
  await play(page, 6);
  await expect(page.getByTestId('handling-person')).toBeVisible();
  await expect(thread.getByText(/a tankless water heater installed is \$3,850/)).toBeVisible();
  await expect(thread.getByText('Yes please, send it over.', { exact: false })).toBeVisible();

  // Scene 5: an upset customer goes straight to you, and your own words calm her down.
  await pick(page, 'upset-customer', 'Open the Inbox');
  await play(page, 6);
  await expect(thread.getByText(/Linda, this is \S+, the owner\./)).toBeVisible();
  await expect(thread.getByText('Thank you for owning it. 8 tomorrow works.')).toBeVisible();

  // Scene 6: the reminder, her approval, and one click from estimate to a sent invoice.
  await pick(page, 'quote-to-invoice', 'Open Carol’s estimate');
  await expect(page).toHaveURL(/\/money\/estimates\/de300000-/);
  await play(page, 6);
  await expect(page).toHaveURL(/\/money\/invoices\/de300000-/);
  await expect(page.getByRole('heading', { name: 'INV-1187' })).toBeVisible();
  await expect(page.getByTestId('document-activity')).toContainText('Sent to Carol Diaz');

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Marcus Reed', 'Priya', 'Tom Alvarez', 'Linda Park', 'Carol Diaz']) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
});

test('demo player: Ask HandsFreeOS sets up services, chases what’s owed, moves a job and asks for reviews', async ({
  page,
}) => {
  test.setTimeout(420_000);
  const workspaceId = await staffBusiness(page, 'demo-assistant');
  await page.goto(`/app/w/${workspaceId}?demo`);
  await expect(director(page)).toBeVisible();
  const thread = page.getByTestId('conversation');

  // Scene 8: hours and three services from one sentence, a card for each, then the services page.
  await pick(page, 'business-setup', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(page).toHaveURL(/\/settings\/calendars\/services/);
  for (const name of ['Drain cleaning', 'Water heater flush', 'Leak repair'])
    await expect(page.getByTestId(`service-row-${name}`)).toBeVisible();
  await expect(page.getByTestId('service-editor')).toContainText('Leak repair');

  // Scene 9: what's owed, a text for each late one, and the first one answers.
  await pick(page, 'money-owed', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(page).toHaveURL(/\/inbox\/de300000-/);
  await expect(thread.getByText(/Just a friendly nudge on invoice INV-1162/)).toBeVisible();
  await expect(
    thread.getByText('So sorry, that one slipped by me. Paying it tonight!'),
  ).toBeVisible();

  // Scene 10: tomorrow's jobs, one moved on a card, and the customer told.
  await pick(page, 'my-day', 'Open Ask HandsFreeOS');
  await play(page, 5);
  await expect(thread.getByText(/Your appointment is now/)).toBeVisible();
  await expect(thread.getByText(/\w+day works even better/)).toBeVisible();
  await expect(page.getByTestId('context-panel').getByText('Water heater install')).toBeVisible();

  // Scene 11: a thank-you with the review link for each job done, and five stars back.
  await pick(page, 'review-requests', 'Open Ask HandsFreeOS');
  await play(page, 4);
  await expect(thread.getByText(/would you leave us a quick review\?/)).toBeVisible();
  await expect(thread.getByText('Done! Five stars.', { exact: false })).toBeVisible();

  // None of it was ever saved.
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/settings/calendars/services`);
  await expect(page.getByTestId('services')).toBeVisible();
  await expect(page.getByTestId('service-row-Leak repair')).toHaveCount(0);
  await page.goto(`/app/w/${workspaceId}/inbox`);
  await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
  for (const name of ['Gary Holt', 'Dave Johnson', 'Linda Park']) {
    await expect(page.getByText(name)).toHaveCount(0);
  }
});

test('demo player: Admin → Demo player plays a scene in your business, each step with its voiceover', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const workspaceId = await staffBusiness(page, 'demo-admin');
  await page.goto('/admin/demo');
  await expect(page.getByRole('heading', { name: 'Demo player' })).toBeVisible();
  await expect(page.getByTestId('admin-nav-demo')).toHaveAttribute('aria-current', 'page');
  // Only the founder opens Bright Path Home Services as its owner; anyone else plays in a business of their own.
  await expect(page.getByText(/Only the founder can open Bright Path Home Services/)).toBeVisible();
  await expect(page.getByTestId(`demo-place-${workspaceId}`)).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // Every scene's voiceover is there to read before recording.
  const money = page.getByTestId('demo-admin-scene-money-owed');
  await money.getByText('Voiceover · 5 steps').click();
  await expect(money.getByText(/Thirty-four days late, and paid the same night\./)).toBeVisible();

  // Play opens the business on that scene, and the address stops asking for it, so a reload carries on.
  await page.getByTestId('demo-play-money-owed').click();
  await expect(director(page)).toBeVisible();
  await expect(page.getByTestId('demo-next-step')).toContainText('Open Ask HandsFreeOS');
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}$`));
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(5);
  await expect(page.getByTestId('demo-next-step')).toContainText(
    'Ask HandsFreeOS knows your money',
  );
  // Not the founder in someone else's business: no note about changes being real.
  await expect(page.getByTestId('demo-acting-note')).toHaveCount(0);

  // The voiceover hides for a cleaner panel, and stays hidden after a reload, until it's shown again.
  await page.getByTestId('demo-voiceover-toggle').click();
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('demo-steps').locator('li').nth(0)).toContainText('✓');
  await page.reload();
  await expect(page.getByTestId('demo-steps').locator('li').nth(0)).toContainText('✓');
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(0);
  await page.getByTestId('demo-voiceover-toggle').click();
  await expect(director(page).getByTestId('demo-voiceover')).toHaveCount(5);
  await page.getByTestId('demo-exit').click();
  await expect(director(page)).toHaveCount(0);
});
