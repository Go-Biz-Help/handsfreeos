import { expect, test } from '@playwright/test';
import { api } from './booking-helpers';
import {
  automaticTeammate,
  businessWithChat,
  CHAT_SITE,
  chatConversations,
  chatFrame,
  chatOwner,
  OTHER_SITE,
  sitePage,
  tabToLauncher,
  teammateReply,
} from './chat-helpers';

/**
 * Settings → Website chat: the sites (checked as they're typed, refused in plain words, the www twin added and
 * shown), the snippet with Copy and the tips, the loader (JavaScript, kept 5 minutes, under 3 KB) and the frame rule,
 * the install check once the chat opens on the test site, the look, the daily limit, pausing, and a new key that
 * stops the old snippet.
 */
test('Website chat settings: sites, the snippet, the install check and a new key', async ({
  page,
  browser,
  context,
}) => {
  test.setTimeout(240_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { workspaceId } = await chatOwner(page, 'chat-settings');

  // In the Settings nav, after Email.
  await page.goto(`/app/w/${workspaceId}/settings`);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  const tabs = await nav.getByRole('link').allTextContents();
  expect(tabs.indexOf('Website chat')).toBe(tabs.indexOf('Email') + 1);
  await nav.getByRole('link', { name: 'Website chat' }).click();
  await expect(page).toHaveURL(new RegExp(`/app/w/${workspaceId}/settings/website-chat$`));

  // Sites are checked as they're typed, and refused in plain words.
  const setup = page.getByTestId('chat-setup');
  const input = page.getByTestId('chat-site-input');
  const note = page.getByTestId('chat-site-note');
  await input.fill('*.acme.com');
  await expect(note).toHaveText(
    'Wildcards like *.acme.com don’t work here. List each site instead.',
  );
  await expect(page.getByTestId('chat-site-submit')).toBeDisabled();
  await input.fill('10.0.0.8');
  await expect(note).toContainText('not a number address');
  await input.fill('https://Acme.com/contact');
  await expect(note).toHaveText('Adds acme.com and www.acme.com.');
  await page.getByTestId('chat-site-submit').click();
  await expect(setup.getByTestId('chat-site')).toHaveCount(1);
  await expect(setup.getByTestId('chat-site')).toContainText('www.acme.com is added for you');
  await input.fill('127.0.0.1:4191');
  await expect(note).toHaveText('Adds http://127.0.0.1:4191.');
  await input.press('Enter');
  await expect(setup.getByTestId('chat-site')).toHaveCount(2);
  await page.getByTestId('chat-create').click();

  // Turned on: the sites, with acme.com's twin, and the snippet exactly as it's pasted.
  await expect(page.getByTestId('chat-settings')).toBeVisible();
  const sites = page.getByTestId('chat-sites').getByTestId('chat-site');
  await expect(sites).toHaveCount(2);
  await expect(sites.filter({ hasText: 'acme.com' })).toContainText(
    'www.acme.com is added for you',
  );
  const snippet = page.getByTestId('chat-snippet');
  await expect(snippet).toHaveText(
    /^<script async src="http:\/\/localhost:3000\/embed\/v1\/wk_[A-Za-z0-9]{20}\.js"><\/script>$/,
  );
  const pasted = (await snippet.textContent())!;
  const key = /wk_[A-Za-z0-9]{20}/.exec(pasted)![0];
  await page.getByTestId('chat-snippet-copy').click();
  await expect(page.getByText('Snippet copied. Paste it once on your site.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(pasted);
  await page.getByRole('radio', { name: 'GoHighLevel' }).click();
  await expect(page.getByTestId('chat-platform-steps')).toContainText('Footer tracking code');

  // The loader: JavaScript, kept for 5 minutes by browsers and the CDN (Vercel's CDN needs s-maxage, and strips it
  // before the browser sees it), under 3 KB.
  const loader = await page.request.get(`/embed/v1/${key}.js`);
  expect(loader.status()).toBe(200);
  expect(loader.headers()['content-type']).toContain('application/javascript');
  expect(loader.headers()['cache-control']).toBe('public, max-age=300, s-maxage=300');
  expect((await loader.body()).byteLength).toBeLessThan(3 * 1024);
  expect(await loader.text()).not.toContain('hfos-chat:');

  // The frame rule names the page the window is on, only when it's one of the widget's sites.
  const on = await page.request.get(`/chat/${key}?o=${encodeURIComponent(CHAT_SITE)}&p=%2F`);
  expect(on.headers()['content-security-policy']).toBe(`frame-ancestors 'self' ${CHAT_SITE}`);
  const off = await page.request.get(`/chat/${key}?o=${encodeURIComponent(OTHER_SITE)}`);
  expect(off.headers()['content-security-policy']).toBe(`frame-ancestors 'self'`);

  // The install check: not seen until the chat opens on the site, then "Seen on 127.0.0.1:4191 just now".
  await expect(page.getByTestId('chat-install')).toContainText('Not seen yet.');
  const visitor = await browser.newContext();
  const site = await visitor.newPage();
  await site.goto(sitePage(CHAT_SITE, key, '/services/ac-tune-up', '#hfos-chat'));
  const chat = await chatFrame(site);
  await expect(chat.getByTestId('chat-window')).toHaveAttribute('data-phase', 'ready');
  await page.getByTestId('chat-install-recheck').click();
  await expect(page.getByTestId('chat-install')).toContainText('Seen on 127.0.0.1:4191 just now');
  await expect(sites.filter({ hasText: '127.0.0.1:4191' })).toContainText('Installed');
  await visitor.close();

  // The look: a colour, a label, the left corner and a greeting, saved together; the loader follows.
  await page.getByTestId('chat-colour-008743').click();
  await page.getByTestId('chat-label').fill('Ask us anything');
  await page.getByTestId('chat-position-left').click();
  await page.getByTestId('chat-greeting').fill('Hi! Questions about heating or cooling? Ask here.');
  await expect(page.getByTestId('chat-look-preview')).toContainText('Ask us anything');
  await expect(page.getByTestId('chat-save-note')).toHaveText('Unsaved changes');
  await page.getByTestId('chat-save').click();
  await expect(page.getByTestId('chat-save-note')).toHaveText('All changes saved');
  const restyled = await (await page.request.get(`/embed/v1/${key}.js`)).text();
  expect(restyled).toContain('"Ask us anything"');
  expect(restyled).toContain('background:#008743');
  expect(restyled).toContain('left:24px');

  // The daily limit saves on Enter.
  await page.getByTestId('chat-daily-cap').fill('150');
  await page.getByTestId('chat-daily-cap').press('Enter');
  await expect(page.getByText('Up to 150 new chats a day.')).toBeVisible();

  // Paused: the loader stays quiet until it's turned back on.
  await page.getByTestId('chat-on').click();
  await expect(page.getByTestId('chat-on-label')).toHaveText('Paused');
  await expect(page.getByTestId('chat-paused')).toBeVisible();
  expect(await (await page.request.get(`/embed/v1/${key}.js`)).text()).toContain('paused');
  await page.getByTestId('chat-on').click();
  await expect(page.getByTestId('chat-on-label')).toHaveText('On');

  // A new key, confirmed: the old snippet stops working, the new one works.
  await page.getByTestId('chat-new-key').click();
  const dialog = page.getByRole('dialog', { name: 'Get a new key?' });
  await expect(dialog).toContainText('stops working');
  await dialog.getByTestId('chat-new-key-confirm').click();
  await expect(snippet).not.toHaveText(pasted);
  const newKey = /wk_[A-Za-z0-9]{20}/.exec((await snippet.textContent())!)![0];
  expect(newKey).not.toBe(key);
  expect((await page.request.get(`/embed/v1/${key}.js`)).status()).toBe(404);
  const fresh = await browser.newContext();
  const old = await fresh.newPage();
  const [script] = await Promise.all([
    old.waitForResponse((r) => r.url().includes(`/embed/v1/${key}.js`)),
    old.goto(sitePage(CHAT_SITE, key)),
  ]);
  expect(script.status()).toBe(404);
  await old.waitForTimeout(1_000);
  await expect(old.locator('hfos-chat')).toHaveCount(0);
  const current = await fresh.newPage();
  await current.goto(sitePage(CHAT_SITE, newKey));
  await expect(current.locator('hfos-chat')).toHaveCount(1);
  await fresh.close();
});

/**
 * Try it: the preview page shows the widget as visitors see it, and its chats go to the AI teammate's test console.
 * They create nothing (no chat in the inbox) and never count as the install check.
 */
test('Try it: the preview answers through the test console and creates nothing', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const biz = await businessWithChat(page, 'chat-preview');
  await automaticTeammate(biz.token, biz.workspaceId, biz.widgetId);

  await page.goto(`/app/w/${biz.workspaceId}/settings/website-chat`);
  await expect(page.getByTestId('chat-who')).toHaveValue(/[0-9a-f-]{36}/);
  const [preview] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('chat-try-it').click(),
  ]);
  await expect(preview.getByTestId('chat-preview-banner')).toContainText(
    'Preview. Chats here create nothing and send nothing.',
  );

  // The same button and window as visitors get, labelled as a preview.
  await tabToLauncher(preview);
  await preview.keyboard.press('Enter');
  const chat = await chatFrame(preview);
  expect(new URL(chat.url()).searchParams.get('preview')).toBe(biz.workspaceId);
  await expect(chat.getByTestId('chat-preview-strip')).toHaveText(
    'Preview. Nothing here is sent or saved.',
  );
  await expect(chat.getByTestId('chat-input')).toBeFocused();
  await preview.keyboard.type('Are you a real person?');
  await preview.keyboard.press('Enter');
  await expect(await teammateReply(chat, biz.workspaceId)).toContainText('AI assistant');

  // Nothing was created or recorded.
  expect(await chatConversations(biz.token, biz.workspaceId)).toHaveLength(0);
  const { widget } = await api<{ widget: { install: { seen: boolean } } }>(
    biz.token,
    'queries',
    'chat_widget.get',
    { workspaceId: biz.workspaceId, widgetId: biz.widgetId },
  );
  expect(widget.install.seen).toBe(false);
});
