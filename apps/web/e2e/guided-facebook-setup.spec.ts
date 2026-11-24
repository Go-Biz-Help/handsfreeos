import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import { chatOwner } from './chat-helpers';

/**
 * The guided Facebook & Instagram setup from Settings → Facebook & Instagram (the owner, 24 Nov 2026, picks F1 a to
 * F4 a): the page is one simple card with every setting from before under All settings. Start asks four questions one
 * at a time (Instagram's steps only with Instagram picked) and saves as it goes; Connect with Facebook saves the rules
 * for someone new, then leaves for Facebook's sign-in through the worker. Facebook itself can't sign in here, so its
 * start page is stood in for, and the live test shows what it says with nothing connected.
 */
test('Settings → Facebook & Instagram: four questions saved as they go, then Connect with Facebook', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const { token, workspaceId } = await chatOwner(page, 'facebook-guided');

  // One simple card: nothing connected, and All settings opens and closes everything from before.
  await page.goto(`/app/w/${workspaceId}/settings/facebook-instagram`);
  await expect(page.getByTestId('facebook-overview')).toBeVisible();
  await expect(page.getByTestId('facebook-answers')).toHaveCount(0);
  await expect(page.getByTestId('facebook-all-settings')).toBeHidden();
  await page.getByTestId('facebook-all-settings-toggle').click();
  await expect(page.getByTestId('meta-none')).toBeVisible();
  await page.getByTestId('facebook-all-settings-toggle').click();
  await expect(page.getByTestId('facebook-all-settings')).toBeHidden();

  // What lands in the inbox: Messenger always; Instagram ticked, so its steps come next.
  await expect(page.getByTestId('facebook-set-up')).toHaveText('Start');
  await page.getByTestId('facebook-set-up').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/facebook$`));
  const card = page.getByTestId('facebook-setup');
  await expect(card).toHaveAttribute('data-screen', 'inbox', { timeout: 60_000 });
  await expect(page.getByTestId('facebook-setup-messenger')).toBeChecked();
  await expect(page.getByTestId('facebook-setup-messenger')).toBeDisabled();
  await expect(page.getByTestId('facebook-setup-instagram')).toBeChecked();
  const next = page.getByTestId('facebook-setup-next');
  await next.click();

  // Get your Instagram ready: ticks never stop Next.
  await expect(card).toHaveAttribute('data-screen', 'instagram');
  await page.getByTestId('facebook-setup-igProfessional').check();
  await page.getByTestId('facebook-setup-igLinked').check();
  await next.click();

  // Saved as it goes: Settings offers to pick up where they left off, on the same question.
  await expect(card).toHaveAttribute('data-screen', 'leads');
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/settings/facebook-instagram`);
  await expect(page.getByTestId('facebook-set-up')).toHaveText('Pick up where you left off');
  await page.getByTestId('facebook-set-up').click();
  await expect(card).toHaveAttribute('data-screen', 'leads', { timeout: 60_000 });
  await expect(page.getByTestId('guided-step-instagram')).toContainText('2 of 3 steps ticked');

  // Someone new: a customer only.
  await page.getByTestId('facebook-setup-customer').click();
  await next.click();

  // Ads: lead ads wait for Meta's approval; No ads right now clears the rest.
  await expect(card).toHaveAttribute('data-screen', 'ads');
  await expect(page.getByTestId('facebook-setup-lead-ads')).toBeDisabled();
  await page.getByTestId('facebook-setup-ads-none').check();
  await expect(page.getByTestId('facebook-setup-ads-chat')).not.toBeChecked();
  await expect(next).toHaveText('Check it over');
  await next.click();

  // Check it over: each answer, and Change goes to that question and straight back.
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(page.getByTestId('facebook-review-inbox')).toContainText(
    'Messenger and Instagram DMs',
  );
  await expect(page.getByTestId('facebook-review-leads')).toContainText('A customer only');
  await expect(page.getByTestId('facebook-review-ads')).toContainText('No ads right now');
  await page.getByTestId('facebook-review-change-ads').click();
  await expect(card).toHaveAttribute('data-screen', 'ads');
  await page.getByTestId('facebook-setup-ads-chat').check();
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(page.getByTestId('facebook-review-ads')).toContainText('Ads that start a chat');
  await expect(next).toHaveText('Connect with Facebook');

  // Connect with Facebook: the rules for someone new are saved, then the browser leaves for the worker's sign-in.
  await page.route('**/oauth/facebook/start**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Facebook</p>' }),
  );
  await next.click();
  await expect(page).toHaveURL(/\/oauth\/facebook\/start\?state=/, { timeout: 60_000 });
  const intake = await api<{ sources: { kind: string; active: boolean; createLead: boolean }[] }>(
    token,
    'queries',
    'intake.list',
    { workspaceId },
  );
  for (const kind of ['messenger', 'instagram'])
    expect(intake.sources.find((s) => s.kind === kind)).toMatchObject({
      active: true,
      createLead: false,
    });

  // The live test with nothing connected says so, with Connect with Facebook again.
  await page.goto(`/onboarding/${workspaceId}/facebook?step=test&ig=1`);
  await expect(page.getByTestId('facebook-test-nothing')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('facebook-test-again')).toHaveText('Connect with Facebook again');
});
