import { expect, test } from '@playwright/test';
import { api, ownerWithSite } from './booking-helpers';

/**
 * Sizes and colors on a product (docs/selling-products.md): the business gives its T-shirt the shirt sizes with a
 * bump on the big ones, and a quote picks Adult 2XL from the catalogue at that size's price.
 */
test('a T-shirt gets its sizes in Settings, and a quote picks one at its price', async ({ page }) => {
  test.setTimeout(150_000);
  const owner = await ownerWithSite(page, 'product-options', 'Crafts-n-Things');

  await page.goto(`/app/w/${owner.workspaceId}/settings/payments/products`);
  await page.getByTestId('product-new').click();
  await page.getByTestId('product-name').fill('T-shirt');
  await page.getByTestId('product-price').fill('12');
  await page.getByTestId('product-option-starter-shirt_sizes').click();
  const options = page.getByTestId('product-options');
  await expect(options.getByTestId('product-option-name')).toHaveValue('Size');
  await expect(options.getByTestId('product-choice')).toHaveCount(12);
  await page.getByLabel('Price change for Adult 2XL').fill('2');
  await expect(page.getByLabel('Adult 2XL costs')).toHaveText('$14');
  // Youth sizes a dollar less.
  await page.getByLabel('Price change for Youth S').fill('-1');
  await expect(page.getByLabel('Youth S costs')).toHaveText('$11');
  // A price change that isn't an amount holds Save.
  await page.getByLabel('Price change for Youth M').fill('two');
  await expect(page.getByTestId('product-save')).toBeDisabled();
  await page.getByLabel('Price change for Youth M').fill('');
  await page.getByTestId('product-save').click();
  await expect(page.getByTestId('product-row-T-shirt')).toContainText('Size (12)');

  const { products } = await api<{
    products: { name: string; options: { choices: { label: string; priceCents: number }[] }[] }[];
  }>(owner.token, 'queries', 'product.list', { workspaceId: owner.workspaceId });
  const sizes = products.find((p) => p.name === 'T-shirt')!.options[0]!.choices;
  expect(sizes.find((c) => c.label === 'Adult 2XL')!.priceCents).toBe(200);
  expect(sizes.find((c) => c.label === 'Youth S')!.priceCents).toBe(-100);

  // A quote: tapping the T-shirt asks for a size, and the line is named and priced with it.
  await page.goto(`/app/w/${owner.workspaceId}/money/estimates/new`);
  await page.getByTestId('line-catalogue').click();
  await page.getByTestId('product-option-T-shirt').click();
  await expect(page.getByTestId('product-choices-add')).toHaveText('Pick a size');
  await expect(page.getByTestId('product-choices-add')).toBeDisabled();
  await page.getByTestId('product-choice-Adult 2XL').click();
  await page.getByTestId('product-choices-add').click();
  const line = page.getByTestId('line-row-T-shirt (Adult 2XL)');
  await expect(line).toBeVisible();
  await expect(page.getByTestId('totals-subtotal-value').first()).toHaveText('$14');
});
