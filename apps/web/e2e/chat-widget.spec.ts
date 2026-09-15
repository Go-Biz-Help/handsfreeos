import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import {
  APP,
  businessWithChat,
  CHAT_SITE,
  chatConversations,
  chatFrame,
  OTHER_SITE,
  recordWindowMessages,
  sitePage,
  tabToLauncher,
  teammateReply,
  windowMessages,
} from './chat-helpers';

/**
 * The website chat on a business's own site (the stand-in at 127.0.0.1:4191, which pastes the snippet), by keyboard
 * alone: the button, the chat window, the AI teammate's reply read inside it, a staff reply arriving live ("Dale
 * joined"), and "Are you a real person?" getting the admission. The window and the page swap only "open", "close"
 * and "unread" (a count), and never a token. On a site that isn't the widget's (127.0.0.1:4192), the browser refuses
 * to show the window (frame-ancestors), and the button takes itself away.
 */
test('the chat on an allowed site, by keyboard: the AI reply, a staff reply live, and the admission', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const biz = await businessWithChat(page, 'chat-desk', { teammate: true });

  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const site = await context.newPage();
  await recordWindowMessages(site);
  await site.goto(sitePage(CHAT_SITE, biz.key));

  // The button, reached with Tab and opened with Enter: the window opens with the composer focused.
  await tabToLauncher(site);
  await site.keyboard.press('Enter');
  await expect(site.locator('hfos-chat[open]')).toHaveCount(1);
  const chat = await chatFrame(site);
  expect(new URL(chat.url()).searchParams.get('o')).toBe(CHAT_SITE);
  await expect(chat.getByTestId('chat-window')).toHaveAttribute('data-phase', 'ready');
  await expect(chat.getByRole('heading', { name: 'Lone Star HVAC & Roofing' })).toBeVisible();
  await expect(chat.getByTestId('chat-subtitle')).toHaveText('Ava (AI) and the team');
  await expect(chat.getByText('Powered by HandsFreeOS')).toBeVisible();
  await expect(chat.getByTestId('chat-input')).toBeFocused();
  // The log is there for screen readers from the start; with no greeting set, a line invites the first message.
  await expect(chat.getByRole('log', { name: 'Messages' })).toBeAttached();
  await expect(chat.getByTestId('chat-empty')).toContainText('Ava (AI) answers right away');
  await expect(chat.locator('header [aria-hidden]').first()).toHaveText('LS');

  // A first message: Ava says she's an AI assistant in her first reply. It goes through Cloudflare's invisible check
  // first (locally and in CI, its always-pass test keys), so it carries a token.
  const firstSent = site.waitForRequest(
    (r) => r.method() === 'POST' && /\/public\/chat\/wk_[A-Za-z0-9]{20}\/messages$/.test(r.url()),
  );
  await site.keyboard.type('Hi, do you service AC units?');
  await site.keyboard.press('Enter');
  expect((await firstSent).postDataJSON()).toMatchObject({ turnstileToken: expect.any(String) });
  await expect(chat.getByTestId('chat-message-visitor')).toContainText(
    'Hi, do you service AC units?',
  );
  const first = await teammateReply(chat, biz.workspaceId, 1);
  await expect(first).toContainText('AI assistant');
  await expect(first).toContainText('Ava');

  // "Are you a real person?" always gets the truth.
  await site.keyboard.type('Are you a real person?');
  await site.keyboard.press('Enter');
  const second = await teammateReply(chat, biz.workspaceId, 2);
  await expect(second).toContainText('an AI assistant');
  await expect(second).not.toContainText('real person here');

  // The transcript is in the inbox; Dale replies there from the chat composer (taking it over from Ava), and the
  // window shows it live, with "Dale joined".
  const [conversation] = await chatConversations(biz.token, biz.workspaceId);
  expect(conversation).toBeTruthy();
  await page.goto(`/app/w/${biz.workspaceId}/inbox/${conversation!.id}`);
  await expect(page.getByTestId('composer-mode-chat')).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('Hi, Dale here. Marco can check the AC on Thursday.');
  await page.getByTestId('composer-send').click();
  await expect(chat.getByTestId('chat-joined')).toHaveText('Dale joined');
  await expect(chat.getByTestId('chat-message-person')).toContainText('Marco can check the AC');

  // Escape closes the window and gives focus back to the button.
  await site.keyboard.press('Escape');
  await expect(site.locator('hfos-chat[open]')).toHaveCount(0);
  expect(await site.evaluate(() => document.activeElement?.tagName)).toBe('HFOS-CHAT');

  // A reply from the composer while it's closed: the page hears only a count ("unread"), never text or a token.
  await composer.fill('He’ll be there at 1 PM.');
  await page.getByTestId('composer-send').click();
  await expect.poll(() => windowMessages(site)).toContainEqual({ hfos: 'unread', n: 1 });
  for (const m of (await windowMessages(site)) as Record<string, unknown>[]) {
    expect(Object.keys(m).sort()).toEqual(expect.arrayContaining(['hfos']));
    expect(['close', 'unread']).toContain(m.hfos);
    expect(Object.keys(m).every((k) => k === 'hfos' || k === 'n')).toBe(true);
  }

  // Enter opens it again, with the new reply there.
  await site.keyboard.press('Enter');
  await expect(site.locator('hfos-chat[open]')).toHaveCount(1);
  await expect(chat.getByTestId('chat-message-person').last()).toContainText('1 PM');
  await expect(chat.getByTestId('chat-input')).toBeFocused();
  await expect.poll(() => windowMessages(site)).toContainEqual({ hfos: 'unread', n: 0 });

  // A returning visitor picks up where they left off (the token lives in the window's own storage).
  await site.reload();
  await tabToLauncher(site);
  await site.keyboard.press('Enter');
  const again = await chatFrame(site);
  await expect(again.getByTestId('chat-message-person').last()).toContainText('1 PM');
  await context.close();
});

test('a site that isn’t on the widget’s list: the browser refuses the chat window', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const biz = await businessWithChat(page, 'chat-refused');

  // The frame rule: our own site, plus the page it's on only when that's one of the widget's sites.
  const allowed = await request.get(
    `${APP}/chat/${biz.key}?o=${encodeURIComponent(CHAT_SITE)}&p=%2F`,
  );
  expect(allowed.headers()['content-security-policy']).toBe(`frame-ancestors 'self' ${CHAT_SITE}`);
  const refused = await request.get(`${APP}/chat/${biz.key}?o=${encodeURIComponent(OTHER_SITE)}`);
  expect(refused.headers()['content-security-policy']).toBe(`frame-ancestors 'self'`);
  const unknown = await request.get(
    `${APP}/chat/wk_00000000000000000000?o=${encodeURIComponent(CHAT_SITE)}`,
  );
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['content-security-policy']).toBe(`frame-ancestors 'self'`);

  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const site = await context.newPage();
  const logs: string[] = [];
  site.on('console', (m) => logs.push(m.text()));
  // The follow-up link's #hfos-chat opens the window at once.
  await site.goto(sitePage(OTHER_SITE, biz.key, '/', '#hfos-chat'));
  await expect(site.locator('hfos-chat')).toHaveCount(1);
  await expect(site.locator('hfos-chat[open]')).toHaveCount(1);
  // The browser refuses to show it, so it never answers, and the button takes itself away.
  await expect(site.locator('hfos-chat')).toHaveCount(0, { timeout: 30_000 });
  expect(logs.some((l) => l.includes(`HandsFreeOS chat is not set up for ${OTHER_SITE}`))).toBe(
    true,
  );
  for (const frame of site.frames())
    if (frame !== site.mainFrame()) await expect(frame.getByTestId('chat-window')).toHaveCount(0);
  // Nothing was recorded: no visit, and no install check from a site that isn't the widget's.
  const { widget } = await api<{ widget: { install: { seen: boolean } } }>(
    biz.token,
    'queries',
    'chat_widget.get',
    { workspaceId: biz.workspaceId, widgetId: biz.widgetId },
  );
  expect(widget.install.seen).toBe(false);
  await context.close();
});
