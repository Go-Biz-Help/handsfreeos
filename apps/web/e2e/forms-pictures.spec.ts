import { expect, test } from '@playwright/test';
import { formWithAnswers } from './forms';

/** A 64 × 48 picture in one colour. */
const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAfUlEQVRoge2SAQkAURSDlsC0F8TIF2M8/sAAOhY+T5O6AQuwviK7kHdJ3YAFWF+RXci7pG7AAqyvyC7kXVI3YAHWV2QX8i6pG7AA6yuyC3mX1A1YgPUV2YW8S+oGLMD6iuxC3iV1AxZgfUV2Ie+SugELsL4iu5B3Sd2AxwN+6nXYtTxbdTgAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Pictures and layout on a form (docs/forms.md, "Pictures and layout"): the owner adds a picture, uploads it from the
 * picker and picks it, makes it medium and puts it on the right, sets two questions side by side, and the preview and
 * the published page show them so.
 */
test('puts a picture on a form, sized and lined up, and two questions side by side', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { workspaceId, formId, slug, site } = await formWithAnswers(page, 'forms-pictures');
  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  const rows = page.getByTestId('question-row');

  await page.getByTestId('add-question').click();
  await page.getByRole('menuitem', { name: 'Picture', exact: true }).click();
  // Nothing to answer, so nothing to require and nowhere for an answer to go.
  await expect(page.getByTestId('question-required')).toHaveCount(0);
  await expect(page.locator('#q-map')).toHaveCount(0);

  // Uploaded from the picker itself, made ready by the worker, then picked.
  await page.getByTestId('question-picture-change').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('picture-upload-input').setInputFiles({
    name: 'crew.png',
    mimeType: 'image/png',
    buffer: PHOTO_PNG,
  });
  const tile = dialog.getByTestId('picture-tile');
  await expect(tile).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await tile.click();
  await expect(dialog).toHaveCount(0);
  // Its title is what it shows: the picture's own name until it's told otherwise.
  await expect(page.locator('#q-title')).toHaveValue('crew.png');
  await page.getByTestId('picture-size-medium').click();
  await page.getByTestId('align-right').click();

  // Your name and Your phone side by side.
  for (const title of ['Your name', 'Your phone']) {
    await rows.filter({ hasText: title }).getByRole('button').first().click();
    await page.getByTestId('question-half-width').click();
  }
  await expect(page.getByTestId('save-state')).toHaveText('Saved', { timeout: 20_000 });

  await page.getByTestId('tab-preview').click();
  const preview = page.getByTestId('form-preview');
  const shown = preview.getByTestId('form-picture');
  await expect(shown).toHaveAttribute('data-size', 'medium');
  await expect(shown).toHaveAttribute('data-align', 'right');
  await expect(shown.locator('img')).toHaveAttribute('alt', 'crew.png');
  await expect(preview.getByTestId('form-row')).toContainText('Your name');
  await expect(preview.getByTestId('form-row')).toContainText('Your phone');
  // On a phone the pair stacks.
  await page.getByTestId('preview-phone').click();
  const row = preview.getByTestId('form-row');
  const [name, phone] = await Promise.all([
    row.locator('#q-q_name0000').boundingBox(),
    row.locator('#q-q_phone000').boundingBox(),
  ]);
  expect(phone!.y).toBeGreaterThan(name!.y + name!.height - 1);

  await page.getByTestId('form-publish').click();
  await expect(page.getByText(/Published version/)).toBeVisible();

  await page.goto(`/f/${site}/${slug}`);
  const live = page.getByTestId('form-picture');
  await expect(live.locator('img')).toHaveAttribute(
    'src',
    new RegExp(`/storage/v1/object/public/pictures/${workspaceId}/[0-9a-f-]{36}\\.webp$`),
  );
  await expect(live).toHaveAttribute('data-align', 'right');
  // Side by side on a computer.
  const [liveName, livePhone] = await Promise.all([
    page.locator('#q-q_name0000').boundingBox(),
    page.locator('#q-q_phone000').boundingBox(),
  ]);
  expect(Math.abs(livePhone!.y - liveName!.y)).toBeLessThan(2);
  expect(livePhone!.x).toBeGreaterThan(liveName!.x);
});
