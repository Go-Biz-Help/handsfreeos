import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import { CHAT_SITE, chatFrame, chatOwner, sitePage } from './chat-helpers';

/**
 * The guided website chat setup from Settings → Website chat (the owner, 23 Nov 2026, picks W1 a to W4 b): the page is
 * one simple card with every setting from before under All settings. Set up website chat asks six questions one at a
 * time and saves as it goes; Turn on website chat makes the chat and turns on Ava's Website chat for it (W1); Put it on
 * your site gives the code and turns green once the chat is seen there; the page then shows each answer with Change,
 * which opens that one question.
 */
test('Settings → Website chat: six questions saved as they go, Ava turned on, the code, then each answer with Change', async ({
  page,
  browser,
  context,
}) => {
  test.setTimeout(240_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { token, workspaceId } = await chatOwner(page, 'chat-guided');
  await api(token, 'commands', 'ai_teammate.create', {
    workspaceId,
    preset: 'lead_responder',
    name: 'Ava',
    disclosure: 'first_message',
  });

  // One simple card: no chat yet, and All settings opens and closes everything from before.
  await page.goto(`/app/w/${workspaceId}/settings/website-chat`);
  await expect(page.getByTestId('chat-overview')).toBeVisible();
  await expect(page.getByTestId('chat-answers')).toHaveCount(0);
  await expect(page.getByTestId('chat-all-settings')).toBeHidden();
  await page.getByTestId('chat-all-settings-toggle').click();
  await expect(page.getByTestId('chat-create')).toBeVisible();
  await page.getByTestId('chat-all-settings-toggle').click();
  await expect(page.getByTestId('chat-all-settings')).toBeHidden();

  // Which website: typed sites are checked as they're typed, with the www twin.
  await expect(page.getByTestId('chat-set-up')).toHaveText('Start');
  await page.getByTestId('chat-set-up').click();
  await expect(page).toHaveURL(new RegExp(`/onboarding/${workspaceId}/chat$`));
  const card = page.getByTestId('chat-setup');
  await expect(card).toHaveAttribute('data-screen', 'sites', { timeout: 60_000 });
  const next = page.getByTestId('chat-setup-next');
  await next.click();
  await expect(page.getByText('Add the website the chat goes on, like acme.com.')).toBeVisible();
  const input = page.getByTestId('chat-setup-site-input');
  await input.fill('*.acme.com');
  await expect(page.getByTestId('chat-setup-site-note')).toContainText('Wildcards');
  await input.fill('127.0.0.1:4191');
  await expect(page.getByTestId('chat-setup-site-note')).toHaveText('Adds http://127.0.0.1:4191.');
  await input.press('Enter');
  await expect(page.getByTestId('chat-setup-site')).toHaveCount(1);
  await next.click();

  // Who answers: Ava, whose Website chat is off, so picking her turns it on.
  await expect(card).toHaveAttribute('data-screen', 'who');
  await expect(page.getByTestId('chat-setup-who-ai')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('chat-setup-who-turn-on')).toContainText('turns it on');
  await next.click();

  // When nobody is answering: a short form, with words of their own.
  await expect(card).toHaveAttribute('data-screen', 'away');
  await page.getByTestId('chat-setup-away-form').click();
  await page.getByTestId('chat-setup-away-message').fill('We’re out on a job. Leave your number.');
  await next.click();

  // Saved as it goes: Settings → Website chat offers to pick up where they left off, on the same question.
  await expect(card).toHaveAttribute('data-screen', 'ask');
  await expect(page.getByTestId('guided-saved')).toBeVisible();
  await page.goto(`/app/w/${workspaceId}/settings/website-chat`);
  await expect(page.getByTestId('chat-set-up')).toHaveText('Pick up where you left off');
  await page.getByTestId('chat-set-up').click();
  await expect(card).toHaveAttribute('data-screen', 'ask', { timeout: 60_000 });
  await expect(page.getByTestId('guided-step-away')).toContainText('A short form first');

  // What it asks: today's three rows (W2 b).
  await page.getByTestId('chat-setup-askEmail').selectOption('never');
  await next.click();

  // How it looks: the button's words show in the preview straight away.
  await expect(card).toHaveAttribute('data-screen', 'look');
  await page.getByTestId('chat-setup-label').fill('Ask us anything');
  await page.getByTestId('chat-setup-colour-008743').click();
  await expect(page.getByTestId('chat-setup-preview-button')).toHaveText('Ask us anything');
  await next.click();

  // Where the button sits: moved up above a bar on phones.
  await expect(card).toHaveAttribute('data-screen', 'place');
  await page.getByTestId('chat-setup-phone-lift').click();
  await page.getByTestId('chat-setup-lift-120').click();
  await next.click();

  // Check it over, then Turn on website chat.
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(page.getByTestId('chat-review-ask')).toContainText('email never');
  await expect(page.getByTestId('chat-review-place')).toContainText('moved up above a bar');
  await expect(next).toHaveText('Turn on website chat');
  await next.click();

  // Put it on your site: the code exactly as it's pasted, and Ava's Website chat is on for this chat (W1).
  await expect(page.getByTestId('chat-setup-install')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('chat-setup-on')).toBeVisible();
  const snippet = page.getByTestId('chat-snippet');
  await expect(snippet).toHaveText(
    /^<script async src=".*\/embed\/v1\/wk_[A-Za-z0-9]{20}\.js"><\/script>$/,
  );
  const pasted = (await snippet.textContent())!;
  const key = /wk_[A-Za-z0-9]{20}/.exec(pasted)![0];
  await page.getByTestId('chat-snippet-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pasted);
  await expect(page.getByTestId('web-person-open')).toHaveText('Email your web person');
  const got = await api<{
    teammate: { config: { channels: { chat: boolean; widgetId: string } } };
  }>(token, 'queries', 'ai_teammate.get', { workspaceId });
  expect(got.teammate.config.channels.chat).toBe(true);
  const { items } = await api<{ items: { id: string; launcherLabel: string }[] }>(
    token,
    'queries',
    'chat_widget.list',
    { workspaceId },
  );
  expect(items).toHaveLength(1);
  expect(items[0]!.launcherLabel).toBe('Ask us anything');
  expect(got.teammate.config.channels.widgetId).toBe(items[0]!.id);

  // The check turns green once the chat opens on the site.
  await expect(page.getByTestId('chat-install')).toContainText('Not seen yet.');
  const visitor = await browser.newContext();
  const site = await visitor.newPage();
  await site.goto(sitePage(CHAT_SITE, key, '/services/ac-tune-up', '#hfos-chat'));
  const chat = await chatFrame(site);
  await expect(chat.getByTestId('chat-window')).toHaveAttribute('data-phase', 'ready');
  await page.getByTestId('chat-install-recheck').click();
  await expect(page.getByTestId('chat-install')).toContainText('Seen on 127.0.0.1:4191');
  await visitor.close();

  // Done, then back to the card: on, seen, and each answer with Change.
  await page.getByTestId('chat-setup-install-done').click();
  await expect(page.getByTestId('chat-setup-done')).toHaveAttribute('data-seen', 'yes');
  await expect(page.getByTestId('chat-setup-done-chips')).toContainText('Ava answers');
  await page.getByTestId('chat-setup-done-close').click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/website-chat$`));
  await expect(page.getByTestId('chat-overview-state')).toHaveText('On');
  await expect(page.getByTestId('chat-set-up')).toHaveCount(0);
  await expect(page.getByTestId('chat-answer-who')).toContainText('Ava');
  await expect(page.getByTestId('chat-answer-look')).toContainText('Green, “Ask us anything”');

  // Change opens that one question; Next goes straight to Check it over, and Save goes back to Settings.
  await page.getByTestId('chat-answer-change-look').click();
  await expect(card).toHaveAttribute('data-screen', 'look', { timeout: 60_000 });
  await expect(page.getByTestId('chat-setup-label')).toHaveValue('Ask us anything');
  await page.getByTestId('chat-setup-label').fill('Chat with Ava');
  await expect(next).toHaveText('Check it over');
  await next.click();
  await expect(card).toHaveAttribute('data-screen', 'review');
  await expect(next).toHaveText('Save my answers');
  await next.click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/website-chat$`));
  await expect(page.getByTestId('chat-answer-look')).toContainText('“Chat with Ava”');

  // Everything from before is still under All settings, and settings search's ?all=1 opens it.
  await page.goto(`/app/w/${workspaceId}/settings/website-chat?all=1`);
  await expect(page.getByTestId('chat-settings')).toBeVisible();
  await expect(page.getByTestId('chat-label')).toHaveValue('Chat with Ava');
});
