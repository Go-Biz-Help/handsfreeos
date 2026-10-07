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
  await expect(card).toContainText('Logo and colour');
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
