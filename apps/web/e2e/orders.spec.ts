import { expect, test } from '@playwright/test';
import { api, ownerWithSite } from './booking-helpers';

/**
 * Orders (product sellers, docs/selling-products.md): the owner takes an order by hand on Money → Orders, with a
 * T-shirt in Adult 2XL from the price list and a mug typed in, for pickup on a day; moves it along; makes its
 * invoice; and finds the pickup on the calendar.
 */
test('an order is taken, moved along, billed and shows on the calendar', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'orders', 'Crafts-n-Things');
  await api(owner.token, 'commands', 'product.create', {
    workspaceId: owner.workspaceId,
    name: 'T-shirt',
    unitPriceCents: 1200,
    options: [
      { name: 'Size', choices: [{ label: 'Adult M' }, { label: 'Adult 2XL', priceCents: 200 }] },
    ],
  });
  await api(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName: 'Sherri',
    lastName: 'Buyer',
    email: `sherri-${Date.now()}@example.com`,
    ignoreDuplicates: true,
  });
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  // Money → Orders, empty at first.
  await page.goto(`/app/w/${owner.workspaceId}/money/orders`);
  await expect(page.getByTestId('money-tab-orders')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('No orders yet')).toBeVisible();
  await page.getByTestId('money-new-order').click();

  // Who it's for, and what they want.
  await page.getByTestId('money-person-picker').fill('Sherri');
  await page
    .getByRole('option', { name: /Sherri Buyer/ })
    .first()
    .click();
  await expect(page.getByTestId('order-person')).toHaveText('Sherri Buyer');
  await page.getByTestId('order-line-catalogue').click();
  await page.getByTestId('product-option-T-shirt').click();
  await page.getByTestId('product-choice-Adult 2XL').click();
  await page.getByTestId('product-choices-add').click();
  const shirt = page.getByTestId('order-line').nth(0);
  await expect(shirt.getByTestId('order-line-name')).toHaveValue('T-shirt (Adult 2XL)');
  await shirt.getByTestId('order-line-qty').fill('5');
  await page.getByTestId('order-line-add').click();
  const mug = page.getByTestId('order-line').nth(1);
  await mug.getByTestId('order-line-name').fill('Mug');
  await mug.getByTestId('order-line-qty').fill('2');
  await mug.getByTestId('order-line-price').fill('15');
  await expect(page.getByTestId('order-lines-total')).toContainText('7 items · $100');
  await page.getByTestId('order-pickup').click();
  await page.getByTestId('order-due').fill(day);
  await page.getByTestId('order-save').click();

  // Its page: number, total, and the steps.
  await expect(page.getByTestId('order-title')).toHaveText('Order #1001');
  await expect(page.getByTestId('order-total')).toHaveText('$100');
  await expect(page.getByTestId('order-page-status')).toHaveText('New');
  await page.getByTestId('order-next').click();
  await expect(page.getByTestId('order-page-status')).toHaveText('Making it');
  await page.getByTestId('order-next').click();
  await expect(page.getByTestId('order-page-status')).toHaveText('Ready for pickup');
  await expect(page.getByTestId('order-next')).toHaveText('Mark picked up');

  // The invoice: a draft with the order's lines.
  await page.getByTestId('order-make-invoice').click();
  await expect(page).toHaveURL(/\/money\/invoices\/[0-9a-f-]{36}/);
  await expect(page.getByTestId('line-row-T-shirt (Adult 2XL)')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('order-invoice-link')).toContainText('$100');
  await expect(page.getByTestId('order-make-invoice')).toHaveCount(0);

  // The list, and the calendar's pickups.
  await page.goto(`/app/w/${owner.workspaceId}/money/orders`);
  await expect(page.getByTestId('order-row-1001')).toContainText(
    'T-shirt (Adult 2XL) × 5, Mug × 2',
  );
  await expect(page.getByTestId('order-row-1001')).toContainText('Ready for pickup');
  await page.goto(`/app/w/${owner.workspaceId}/calendar?view=week&date=${day}`);
  await expect(page.getByTestId('calendar-order-1001').first()).toContainText('Sherri Buyer');
});
