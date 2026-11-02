import { expect, test } from '@playwright/test';
import { formWithAnswers } from './forms';

/**
 * A form's Design tab (docs/forms.md, "How a form looks"): the owner picks a button colour, round corners and
 * underlined fields, publishes, and the form's own page shows them. Embedded, the form tells the page around it how
 * tall it is, and the one-line script under the iframe (/embed/v1/form.js) fits the box to it.
 */
test('designs a form, and the published page and its embed follow the design', async ({ page }) => {
  test.setTimeout(150_000);
  const { workspaceId, formId, slug, site } = await formWithAnswers(page, 'forms-design');

  await page.goto(`/app/w/${workspaceId}/forms/${formId}`);
  await page.getByTestId('tab-design').click();
  await expect(page.getByTestId('form-design')).toBeVisible();
  await page.getByTestId('design-color-button-pick').click();
  await page.getByTestId('design-color-button-input').fill('#0b6e4f');
  await page.getByTestId('design-corners-round').click();
  await page.getByTestId('design-fields-underline').click();
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
});
