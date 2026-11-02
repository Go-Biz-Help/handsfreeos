import { expect, test } from '@playwright/test';
import { formWithAnswers } from './forms';

/**
 * A form's Design tab (docs/forms.md, "How a form looks"): the owner types a button colour's hex, picks round corners
 * and underlined fields, hides the form's name, publishes, and the form's own page shows them, its texting permission
 * box drawn in the same corners. Embedded, the form tells the page around it how tall it is, and the one-line script
 * under the iframe (/embed/v1/form.js) fits the box to it, and the frame GoDaddy's HTML section wraps it in too.
 */
test('designs a form, and the published page and its embed follow the design', async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId, formId, slug, site } = await formWithAnswers(page, 'forms-design');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-design').click();
  await expect(page.getByTestId('form-design')).toBeVisible();
  // Typed or pasted, any case, with or without the #.
  const hex = page.getByTestId('design-color-button-hex');
  await hex.fill('0B6E4F');
  await hex.press('Enter');
  await expect(hex).toHaveValue('#0b6e4f');
  await page.getByTestId('design-corners-round').click();
  await page.getByTestId('design-fields-underline').click();
  await page.getByTestId('design-title').click();
  // The preview beside the choices shows them before anything is published.
  const preview = page.getByTestId('form-design').locator('.form-look').first();
  await expect(preview).toHaveAttribute('data-fields', 'underline');
  await expect(page.getByTestId('save-state')).toContainText('Saved');
  await page.getByTestId('form-publish').click();
  await expect(page.getByText('Published version 2.')).toBeVisible();

  // The form's own page, as a customer opens it.
  await page.goto(`/f/${site}/${slug}`);
  const look = page.locator('.form-look').first();
  await expect(look).toHaveAttribute('data-fields', 'underline');
  const send = page.locator('[data-form-action]').first();
  await expect(send).toBeVisible();
  expect(await send.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(11, 110, 79)',
  );
  expect(await send.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('22px');
  // The name is gone from sight, still there for screen readers.
  await expect(page.getByRole('heading', { name: 'Job feedback' })).toHaveClass(/sr-only/);
  // HandsFreeOS's own texting box, in the form's corners like its other boxes.
  const permission = page.getByTestId('form-sms-consent').locator('xpath=../..');
  expect(await permission.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('22px');

  // The Share tab's snippet carries the line that fits the box.
  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-share').click();
  await expect(page.getByText('/embed/v1/form.js').first()).toBeVisible();

  // Embedded on a page (one on HandsFreeOS's own address, which every form allows), with that line under it: the box
  // starts at the old fixed 120 pixels and grows to the whole form, with no scroll bar inside.
  const host = 'http://localhost:3000/e2e-form-host';
  await page.route(host, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <iframe id="hfos-form" src="/f/${site}/${slug}?embed=1" width="100%" height="120" style="border:0"></iframe>
        <script src="/embed/v1/form.js" async></script>
      </body></html>`,
    }),
  );
  await page.goto(host);
  const frame = page.locator('#hfos-form');
  await expect
    .poll(async () => Number(await frame.getAttribute('height')), { timeout: 30_000 })
    .toBeGreaterThan(300);
  const inner = page.frameLocator('#hfos-form');
  await expect(inner.getByTestId('form-embed')).toBeVisible();
  const fits = await inner.locator('html').evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  expect(fits).toBe(true);

  // Pasted in GoDaddy's HTML section, which puts the code in a frame of its own (`srcdoc`, on the site's address)
  // that starts at the browser's 150 pixels: that frame grows with the form too.
  const builder = 'http://localhost:3000/e2e-builder-host';
  const snippet = `<iframe id="hfos-form" src="http://localhost:3000/f/${site}/${slug}?embed=1" width="100%" height="720" style="border:0"></iframe><script src="http://localhost:3000/embed/v1/form.js" async></script>`;
  await page.route(builder, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <iframe id="builder-section" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          style="width:100%;border:0" srcdoc="${snippet.replace(/"/g, '&quot;')}"></iframe>
      </body></html>`,
    }),
  );
  await page.goto(builder);
  const section = page.locator('#builder-section');
  const form = page.frameLocator('#builder-section').locator('#hfos-form');
  await expect
    .poll(async () => Number(await form.getAttribute('height')), { timeout: 30_000 })
    .toBeGreaterThan(300);
  const formHeight = Number(await form.getAttribute('height'));
  await expect
    .poll(async () => (await section.boundingBox())?.height ?? 0, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(formHeight);
});
