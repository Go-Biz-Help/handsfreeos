import { expect, test } from '@playwright/test';
import { consentToAssistant } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Asking and leaving (`packages/core/src/assistant/catch-up.ts`), against the scripted stand-in model's slow answer
 * ("Take your time…" thinks for 15 seconds): a question sent just before the tab is closed is still answered, and
 * opening the Assistant in a new tab reopens that chat, says it's still working, and shows the answer once it lands.
 * Once it has been seen, a new tab starts a fresh chat again.
 */
test('assistant: ask, close the tab at once, and find the answer on coming back', async ({
  page,
  context,
}) => {
  test.setTimeout(150_000);
  const owner = await signUpAndConfirm(page, 'assistant-leave');
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  await consentToAssistant(owner.email);
  await page.goto(`/app/w/${workspaceId}`);
  await page.getByTestId('ask-assistant').click();
  const panel = page.getByTestId('assistant-panel');
  const box = panel.getByRole('textbox', { name: 'Message the Assistant' });
  await box.fill('Take your time: anything new today?');
  const reached = page.waitForResponse((r) => r.url().includes('/v1/assistant/messages'));
  await box.press('Enter');
  // While it works, the panel says leaving is fine.
  await expect(panel.getByTestId('assistant-hint')).toHaveText(
    'You can leave. The answer will be here when you come back.',
  );
  // The worker has the question: close the tab there and then.
  await reached;
  await page.close();

  const back = await context.newPage();
  await back.goto(`/app/w/${workspaceId}`);
  await back.getByTestId('ask-assistant').click();
  const again = back.getByTestId('assistant-panel');
  await expect(again.getByTestId('assistant-question').last()).toHaveText(
    'Take your time: anything new today?',
  );
  const answer = again.getByTestId('assistant-message').last();
  await expect(answer).toHaveAttribute('data-state', 'live');
  await expect(answer.getByTestId('assistant-steps')).toContainText(
    'Still working on it. It’ll be here when you come back.',
  );
  await expect(answer).toHaveAttribute('data-state', 'done', { timeout: 45_000 });
  await expect(answer).toContainText(
    'All done. That one took a little while, so I finished it while you were away.',
  );
  await expect(again.getByTestId('assistant-hint')).toHaveText(
    'Asks before it contacts customers or changes records',
  );

  // Seen now, so it isn't reopened: another new tab starts fresh, and the chat is in Your chats.
  const later = await context.newPage();
  await later.goto(`/app/w/${workspaceId}`);
  await later.getByTestId('ask-assistant').click();
  await expect(later.getByTestId('assistant-panel').getByTestId('assistant-empty')).toBeVisible();
});
