import { expect, test } from '@playwright/test';
import { api, ownerWithSite } from './booking-helpers';

/**
 * Stock (product sellers, docs/selling-products.md "Stock"): the owner counts a T-shirt by size in Settings →
 * Payments → Products, with a number to hear at; an order picked up takes its shirts off; the list says what's low,
 * and the order page says what it took.
 */
test('stock is counted by size and an order picked up takes its own off', async ({ page }) => {
  test.setTimeout(150_000);
  const owner = await ownerWithSite(page, 'stock', 'Pins-n-Mugs');
  const made = await api<{
    productId: string;
    product: { options: { choices: { id: string; label: string }[] }[] };
  }>(owner.token, 'commands', 'product.create', {
    workspaceId: owner.workspaceId,
    name: 'T-shirt',
    unitPriceCents: 1200,
    options: [{ name: 'Size', choices: [{ label: 'Adult M' }, { label: 'Adult 2XL' }] }],
  });
  const adultM = made.product.options[0]!.choices[0]!.id;

  // Count it by size, with a number to hear at.
  await page.goto(`/app/w/${owner.workspaceId}/settings/payments/products`);
  await page.getByTestId('product-row-T-shirt').click();
  const editor = page.getByTestId('product-editor');
  await editor.getByTestId('product-stock').click();
  await editor.getByTestId('product-stock-by').selectOption({ label: 'By size' });
  await editor.getByTestId('stock-count-Adult M').fill('5');
  await editor.getByTestId('stock-count-Adult 2XL').fill('2');
  await editor.getByTestId('product-stock-low').fill('2');
  await editor.getByTestId('product-save').click();
  await expect(
    page.getByTestId('product-row-T-shirt').getByTestId('product-stock-line-T-shirt'),
  ).toHaveText('7 on hand · 1 size low');

  // An order for 4 in Adult M, picked up.
  const person = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName: 'Pat',
    lastName: 'Buyer',
    email: `pat-${Date.now()}@example.com`,
    ignoreDuplicates: true,
  });
  const order = await api<{ orderId: string }>(owner.token, 'commands', 'order.create', {
    workspaceId: owner.workspaceId,
    personId: person.personId,
    lines: [
      {
        productId: made.productId,
        choiceIds: [adultM],
        name: 'T-shirt (Adult M)',
        quantity: 4,
        unitPriceCents: 1200,
      },
    ],
    fulfilment: 'pickup',
  });
  await page.goto(`/app/w/${owner.workspaceId}/money/orders/${order.orderId}`);
  await expect(page.getByTestId('order-line-stock')).toHaveText(
    'Comes off stock when it’s picked up · 5 on hand',
  );
  for (const step of ['Making it', 'Ready for pickup', 'Picked up']) {
    await page.getByTestId('order-next').click();
    await expect(page.getByTestId('order-page-status')).toHaveText(step);
  }
  await expect(page.getByTestId('order-line-stock')).toHaveText('Took 4 off stock · 1 left');

  await page.goto(`/app/w/${owner.workspaceId}/settings/payments/products`);
  await expect(
    page.getByTestId('product-row-T-shirt').getByTestId('product-stock-line-T-shirt'),
  ).toHaveText('3 on hand · 2 sizes low');
});
