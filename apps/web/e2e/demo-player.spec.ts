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
