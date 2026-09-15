import { expect, test } from '@playwright/test';
import { businessWithChat, CHAT_SITE, chatFrame, sitePage, teammateReply } from './chat-helpers';

test.use({ colorScheme: 'dark' });

/**
 * The website chat on a phone at 390 px, in dark mode: the button clear of the edges, the window as a full-screen
 * sheet with the page's scroll locked behind it, a 16 px text box (phones don't zoom in), nothing wider than the
 * phone, the visitor's dark setting followed, and the AI teammate's reply.
 */
test('the chat on a phone: a full-screen sheet, the page locked, a 16 px box, dark', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const biz = await businessWithChat(page, 'chat-phone', { teammate: true });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  const site = await context.newPage();
  await site.goto(sitePage(CHAT_SITE, biz.key));
  await expect(site.locator('hfos-chat')).toHaveCount(1);
  expect(
    await site.evaluate(() => document.documentElement.scrollHeight > window.innerHeight),
  ).toBe(true);

  // The button sits in the bottom-right corner, 16 px from the edges: tap it.
  await site.touchscreen.tap(390 - 16 - 40, 844 - 16 - 27);
  await expect(site.locator('hfos-chat[open]')).toHaveCount(1);
  const chat = await chatFrame(site);
  await expect(chat.getByTestId('chat-window')).toHaveAttribute('data-phase', 'ready');

  // A full-screen sheet, with the page behind it locked.
  const box = await (await chat.frameElement()).boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  expect(await site.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    'hidden',
  );

  // A 16 px text box and 44 px targets; dark, as the visitor's phone is; nothing wider than the phone.
  const input = chat.getByTestId('chat-input');
  await expect(input).toHaveCSS('font-size', '16px');
  expect((await chat.getByTestId('chat-send').boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect((await chat.getByTestId('chat-close').boundingBox())?.height).toBeGreaterThanOrEqual(40);
  await expect(chat.getByTestId('chat-window')).toHaveCSS('background-color', 'rgb(25, 29, 37)');
  expect(await chat.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // A message, and Ava's reply.
  await input.tap();
  await input.fill('Hi, is anyone there? Our AC stopped blowing cold.');
  await chat.getByTestId('chat-send').tap();
  await expect(chat.getByTestId('chat-message-visitor')).toContainText('stopped blowing cold');
  await expect(await teammateReply(chat, biz.workspaceId)).toContainText('AI assistant');

  // Closing gives the page its scroll back.
  await chat.getByTestId('chat-close').tap();
  await expect(site.locator('hfos-chat[open]')).toHaveCount(0);
  expect(await site.evaluate(() => document.documentElement.style.overflow)).toBe('');
  await context.close();
});
