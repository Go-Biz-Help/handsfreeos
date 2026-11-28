import { expect, test } from '@playwright/test';
import { ownerWithSite } from './booking-helpers';

/** A logo with a script in it: never drawn. */
const UNSAFE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40">' +
  '<script>alert(1)</script><rect width="100" height="40" fill="#b42318"/></svg>';
/** A square logo in one colour. */
const SQUARE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
  '<rect width="120" height="120" fill="#008743"/></svg>';

/**
 * Settings → Workspace's logo and colour (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4), as the
 * setup's screen shows them: a picture that can't be shown safely is refused with why; one that can is made ready by
 * the worker, its colour coming with it; a colour picked replaces it and is kept; and a logo taken off leaves the
 * initials, the colour staying. A square logo sits beside the name on the booking page, which takes the colour too.
 */
test('Settings: a logo refused and why, one made ready, a colour picked, and the logo taken off', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { workspaceId, site } = await ownerWithSite(page, 'look-owner', 'Lone Star HVAC');
  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  const card = page.getByTestId('look-card');
  await expect(card).toContainText('Brand kit');
  await expect(card.getByTestId('look-no-logo')).toContainText('Your initials stand in');
  await expect(card.getByTestId('look-colour-2d69d8')).toHaveAttribute('aria-checked', 'true');

  // A picture with a script in it is refused, and says why.
  await card.getByTestId('look-file').setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(UNSAFE_SVG),
  });
  await expect(card.getByTestId('look-problem')).toContainText(
    'That SVG has parts we can’t show safely',
    { timeout: 60_000 },
  );
  await expect(card.getByTestId('look-no-logo')).toBeVisible();

  // One that can be shown is made ready, and its colour comes with it.
  await card.getByTestId('look-file').setInputFiles({
    name: 'mark.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(SQUARE_SVG),
  });
  await expect(card.getByTestId('look-logo-from')).toHaveText('Uploaded.', { timeout: 60_000 });
  await expect(card.getByTestId('look-problem')).toHaveCount(0);
  await expect(card.getByTestId('look-colour-value')).toHaveText('#008743');
  await expect(card.getByTestId('look-colour-from')).toHaveText('From your logo');

  // A colour picked replaces the logo's, and is kept.
  await card.getByTestId('look-colour-7c3aed').click();
  await expect(card.getByTestId('look-colour-from')).toHaveCount(0);
  await expect(page.getByText('Colour saved')).toBeVisible();
  await page.reload();
  await expect(card.getByTestId('look-colour-7c3aed')).toHaveAttribute('aria-checked', 'true');
  await expect(card.getByTestId('look-logo-from')).toHaveText('Uploaded.');

  // The booking page: the square logo beside the name, and the colour on its buttons.
  const booking = await page.context().newPage();
  await booking.goto(`/book/${site}`);
  await expect(booking.getByTestId('business-logo')).toHaveAttribute(
    'src',
    new RegExp(`/storage/v1/object/public/brand/${workspaceId}/logo/[0-9a-f-]{36}\\.png$`),
  );
  await expect(booking.getByTestId('business-name')).toHaveText('Lone Star HVAC');
  await expect(booking.getByTestId('business-name')).not.toHaveClass(/sr-only/);
  await expect(booking.getByTestId('public-page')).toHaveAttribute('style', /--accent:\s*#7c3aed/);
  await booking.close();

  // Taken off, the initials stand in again; the colour stays.
  await card.getByTestId('look-remove').click();
  await expect(card.getByTestId('look-no-logo')).toBeVisible();
  await expect(page.getByText('Logo removed')).toBeVisible();
  await expect(card.getByTestId('look-colour-7c3aed')).toHaveAttribute('aria-checked', 'true');
});

/** A 64 × 48 picture in one colour. */
const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAfUlEQVRoge2SAQkAURSDlsC0F8TIF2M8/sAAOhY+T5O6AQuwviK7kHdJ3YAFWF+RXci7pG7AAqyvyC7kXVI3YAHWV2QX8i6pG7AA6yuyC3mX1A1YgPUV2YW8S+oGLMD6iuxC3iV1AxZgfUV2Ie+SugELsL4iu5B3Sd2AxwN+6nXYtTxbdTgAAAAASUVORK5CYII=',
  'base64',
);

/**
 * The rest of the brand kit and Your pictures (HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, part 1): a font and
 * corners picked are kept; a picture uploaded is made ready by the worker, can be named and say what it shows, and
 * comes out of the library when removed.
 */
test('Settings: the brand kit’s font and corners, and a picture added, named and removed', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { workspaceId } = await ownerWithSite(page, 'kit-owner', 'Kit Roofing');
  await page.goto(`/app/w/${workspaceId}/settings/workspace`);
  const kit = page.getByTestId('brand-kit');

  await kit.getByTestId('brand-kit-font').selectOption('Poppins');
  await expect(page.getByText('Font saved')).toBeVisible();
  await kit.getByTestId('brand-kit-corners-round').click();
  await expect(page.getByText('Corners saved')).toBeVisible();
  await page.reload();
  await expect(kit.getByTestId('brand-kit-font')).toHaveValue('Poppins');
  await expect(kit.getByTestId('brand-kit-corners-round')).toHaveAttribute('aria-selected', 'true');

  const pictures = page.getByTestId('pictures-card');
  await expect(pictures).toContainText('No pictures yet');
  await pictures.getByTestId('picture-upload-input').setInputFiles({
    name: 'crew.png',
    mimeType: 'image/png',
    buffer: PHOTO_PNG,
  });
  const tile = pictures.getByTestId('picture-tile');
  await expect(tile).toHaveAttribute('data-status', 'ready', { timeout: 60_000 });
  await expect(tile.locator('img')).toHaveAttribute(
    'src',
    new RegExp(`/storage/v1/object/public/pictures/${workspaceId}/[0-9a-f-]{36}\\.webp$`),
  );

  await tile.click();
  const dialog = page.getByTestId('picture-dialog');
  await dialog.getByTestId('picture-name').fill('Crew on a roof');
  await dialog.getByTestId('picture-words').fill('Our crew on a roof in Austin');
  await dialog.getByTestId('picture-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(tile).toHaveAttribute('aria-label', 'Our crew on a roof in Austin');
  await expect(tile).toContainText('Crew on a roof');

  await tile.click();
  await page.getByTestId('picture-remove').click();
  await expect(page.getByText('Picture removed.')).toBeVisible();
  await expect(pictures.getByTestId('picture-tile')).toHaveCount(0);
});
