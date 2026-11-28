import { expect, test } from '@playwright/test';
import { makeCalendar, ownerWithSite } from './booking-helpers';
import { APP, CHAT_SITE } from './chat-helpers';

/** A 64 × 48 picture in one colour. */
const PHOTO_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAfUlEQVRoge2SAQkAURSDlsC0F8TIF2M8/sAAOhY+T5O6AQuwviK7kHdJ3YAFWF+RXci7pG7AAqyvyC7kXVI3YAHWV2QX8i6pG7AA6yuyC3mX1A1YgPUV2YW8S+oGLMD6iuxC3iV1AxZgfUV2Ie+SugELsL4iu5B3Sd2AxwN+6nXYtTxbdTgAAAAASUVORK5CYII=',
  'base64',
);

/**
 * Booking pages in design tools part 3 (docs/forms.md, "Pop-ups and booking pages"): the owner puts a picture across
 * the top of a calendar and makes it wide with more space, saves, and puts the design on their other calendar with
 * Use on all my calendars. Both booking pages show it. Then the calendar goes on the stand-in site as a pop-up: a
 * button opens it, and one that opens by itself after a second stays away once it's closed.
 */
test('a calendar’s picture, width and spacing, on all calendars, and in a pop-up on a website', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await ownerWithSite(page, 'booking-popup', 'Lone Star Popup HVAC');
  const cal = await makeCalendar(owner, 'Duct cleaning');
  const other = await makeCalendar(owner, 'AC tune-up');

  await page.goto(`/app/w/${owner.workspaceId}/settings/calendars/${cal.id}/all`);
  // A press before the page has woken up does nothing, so press again until the section opens.
  const design = page.getByTestId('calendar-design');
  await expect(async () => {
    if (!(await design.isVisible()))
      await page.getByTestId('module-design').click({ timeout: 2_000 });
    await expect(design).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });

  // Uploaded from the picker, made ready by the worker, then picked.
  await page.getByTestId('design-cover-change').click();
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
  await expect(page.getByTestId('design-preview').getByTestId('form-cover')).toBeVisible();
  await page.getByTestId('design-width-wide').click();
  await page.getByTestId('design-spacing-roomy').click();
  // Not saved yet: it's the saved design that goes on the others.
  await expect(page.getByTestId('design-everywhere-open')).toBeDisabled();
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('builder-save-note')).toHaveText(/All changes saved/);
  await page.getByTestId('design-everywhere-open').click();
  await page.getByTestId('design-everywhere-confirm').click();
  await expect(page.getByText('1 other calendar uses this design now.')).toBeVisible();

  // Both booking pages wear it: the picture on the first step, and the wider times.
  const context = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const customer = await context.newPage();
  for (const c of [cal, other]) {
    await customer.goto(`${APP}${c.path}`);
    await expect(customer.getByTestId('form-cover')).toBeVisible();
    await expect(customer.getByTestId('form-cover')).toHaveAttribute(
      'src',
      new RegExp(`/storage/v1/object/public/pictures/${owner.workspaceId}/[0-9a-f-]{36}\\.webp$`),
    );
    await expect(customer.getByTestId('step-time')).toHaveCSS('max-width', '1040px');
    await expect(customer.getByTestId('step-time')).toHaveCSS('row-gap', '24px');
  }

  // The pop-up: the site listed, then the code for a button that opens it.
  await page.getByTestId('builder-embed-open').click();
  const embed = page.getByTestId('calendar-embed');
  await expect(embed).toBeVisible();
  const sites = page.getByTestId('calendar-embed-sites');
  await sites.fill('127.0.0.1:4191');
  await sites.press('Enter');
  await expect(sites).toHaveValue(CHAT_SITE);
  await page.getByTestId('calendar-embed-popup').click();
  await page.getByTestId('calendar-popup-label').fill('Book a cleaning');
  const code = page.getByTestId('calendar-popup-code');
  await expect(code).toHaveAttribute('data-code', /Book a cleaning<\/button>/);
  const button = (await code.getAttribute('data-code'))!;
  expect(button).toContain(`data-hfos-popup="${APP}${cal.path}?embed=1"`);

  const site = await context.newPage();
  await site.goto(`${CHAT_SITE}/services/ducts?snippet=${encodeURIComponent(button)}`);
  await site.getByRole('button', { name: 'Book a cleaning' }).click();
  const popup = site.getByRole('dialog', { name: 'Duct cleaning' });
  await expect(popup).toBeVisible();
  await expect(
    site.frameLocator('iframe[title="Duct cleaning"]').getByTestId('booking-embed'),
  ).toBeVisible();
  await site.getByRole('button', { name: 'Close' }).click();
  await expect(popup).toHaveCount(0);

  // By itself after a second; closed, it doesn't come back on the next visit.
  await page.getByTestId('calendar-popup-opens-after').click();
  await page.getByTestId('calendar-popup-seconds').fill('1');
  await expect(code).toHaveAttribute('data-code', /data-hfos-seconds="1"/);
  const after = (await code.getAttribute('data-code'))!;
  await site.goto(`${CHAT_SITE}/services/ducts?snippet=${encodeURIComponent(after)}`);
  await expect(popup).toBeVisible({ timeout: 10_000 });
  await site.getByRole('button', { name: 'Close' }).click();
  await site.reload();
  await site.waitForTimeout(2_500);
  await expect(site.getByRole('dialog')).toHaveCount(0);
  await context.close();
});
