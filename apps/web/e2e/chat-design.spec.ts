import { expect, test } from '@playwright/test';
import { businessWithChat, CHAT_SITE, chatFrame, sitePage } from './chat-helpers';

/** A 64 × 48 picture in one colour. */
const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAfUlEQVRoge2SAQkAURSDlsC0F8TIF2M8/sAAOhY+T5O6AQuwviK7kHdJ3YAFWF+RXci7pG7AAqyvyC7kXVI3YAHWV2QX8i6pG7AA6yuyC3mX1A1YgPUV2YW8S+oGLMD6iuxC3iV1AxZgfUV2Ie+SugELsL4iu5B3Sd2AxwN+6nXYtTxbdTgAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Website chat in design tools part 4 (docs/forms.md, "Website chat look"): the owner picks a font and square corners,
 * writes a greeting bubble that shows after a second, and puts a face in the top bar from Your pictures, then saves.
 * The loader draws the button that way and adds the bubble; on the stand-in site the bubble pops up, opens the chat,
 * and stays away for the rest of the visit, and the chat's top bar has the face.
 */
test('a chat’s font, corners, greeting bubble and face, on a website', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const biz = await businessWithChat(page, 'chat-design');
  await page.goto(`/app/w/${biz.workspaceId}/settings/website-chat?all=1`);
  await expect(page.getByTestId('chat-design')).toBeVisible();

  await page.getByTestId('chat-font').selectOption('Poppins');
  await page.getByTestId('chat-corners-square').click();
  await page.getByTestId('chat-bubble').fill('Need a quote? I can help.');
  await page.getByTestId('chat-bubble-after').fill('1');
  // Uploaded from the picker, made ready by the worker, then picked.
  await page.getByTestId('chat-face-picker-change').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('picture-upload-input').setInputFiles({
    name: 'dale.png',
    mimeType: 'image/png',
    buffer: PHOTO_PNG,
  });
  const tile = dialog.getByTestId('picture-tile');
  await expect(tile).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await tile.click();
  await expect(dialog).toHaveCount(0);

  // The preview shows it before it's saved.
  await expect(page.getByTestId('chat-look-preview-face')).toBeVisible();
  await expect(page.getByTestId('chat-look-preview-bubble')).toHaveText(
    'Need a quote? I can help.',
  );
  await expect(page.getByTestId('chat-look-preview-button')).toHaveCSS(
    'border-top-left-radius',
    '0px',
  );
  await page.getByTestId('chat-save').click();
  await expect(page.getByTestId('chat-save-note')).toHaveText('All changes saved');

  // The loader: a square button in the font, then the bubble's own script.
  const loader = await (await page.request.get(`/embed/v1/${biz.key}.js`)).text();
  expect(loader).toContain('border-radius:0px');
  expect(loader).toContain('font:600 15px \\"Poppins\\",system-ui');
  expect(loader).toContain('/*HandsFreeOS chat bubble*/');
  expect(loader).toContain('"Need a quote? I can help."');

  // On the site: the bubble after a second. It's in a closed shadow root like the button, so it's reached as a
  // keyboard does, and Enter on its words opens the chat.
  const visitor = await browser.newContext();
  const site = await visitor.newPage();
  await site.goto(sitePage(CHAT_SITE, biz.key));
  await expect(site.locator('hfos-bubble')).toHaveCount(1, { timeout: 15_000 });
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await site.keyboard.press('Tab');
    reached = await site.evaluate(() => document.activeElement?.tagName === 'HFOS-BUBBLE');
  }
  expect(reached).toBe(true);
  await site.keyboard.press('Enter');
  await expect(site.locator('hfos-chat')).toHaveAttribute('open', '');
  await expect(site.locator('hfos-bubble')).toHaveCount(0);
  // The address is as it was: nothing added to it.
  expect(new URL(site.url()).hash).toBe('');

  const chat = await chatFrame(site);
  await expect(chat.getByTestId('chat-face')).toBeVisible();
  await expect(chat.getByTestId('chat-face')).toHaveAttribute(
    'src',
    new RegExp(`/storage/v1/object/public/pictures/${biz.workspaceId}/[0-9a-f-]{36}\\.webp$`),
  );
  await expect(chat.getByTestId('chat-window')).toHaveCSS('font-family', /Poppins/);

  // Opened once, it stays away for the rest of the visit.
  await site.reload();
  await expect(site.locator('hfos-chat')).toHaveCount(1);
  await site.waitForTimeout(2_500);
  await expect(site.locator('hfos-bubble')).toHaveCount(0);
  await visitor.close();
});
