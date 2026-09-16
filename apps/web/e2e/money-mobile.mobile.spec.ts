import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * Money in a hand, at 390 px (design/m9 Phone.dc.html). The Money lists, Products and the plans page each
 * carry a table that will not fit in a phone, so each has a card list beside it; the editor's sticky totals
 * bar grows when its breakdown is opened and must never end up over the last row of the sheet.
 *
 * Every assertion here is about the phone: which of the two shapes renders, that nothing scrolls sideways,
 * and that the bar clears what is under it. What the numbers say is `money.spec.ts`'s job.
 *
 * Open hours and quiet hours are pinned so it passes at any hour of any day.
 */

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

interface Owner {
  readonly token: string;
  readonly workspaceId: string;
}

async function moneyOwner(page: Page, label: string): Promise<Owner> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: 'Lone Star HVAC & Roofing' });
  const { token } = await signInOwner(email);
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: { openHours: ALL_WEEK },
  });
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  await api(token, 'commands', 'money.save_settings', {
    workspaceId,
    settings: {
      tax: { rateBp: 825, name: 'TX sales tax', newProductsTaxable: true },
      terms: 'net_14',
      numbering: {
        estimate: { prefix: 'EST-', next: 1001, pad: 4 },
        invoice: { prefix: 'INV-', next: 1001, pad: 4 },
      },
    },
  });
  return { token, workspaceId };
}

/** Nothing on this page may scroll sideways: the whole phone pass turns on it. */
async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(() => {
    const d = document.documentElement;
    return { scroll: d.scrollWidth, width: d.clientWidth };
  });
  expect(over.scroll, 'the page scrolls sideways at 390px').toBeLessThanOrEqual(over.width);
}

test('Money at 390px: every list has a phone shape, and nothing scrolls sideways', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const o = await moneyOwner(page, 'money-phone');

  // A catalogue with more columns than a phone has room for, and a plan sold from it.
  for (const p of [
    { name: 'Duct cleaning · whole home', kind: 'service', unitPriceCents: 45_000 },
    { name: 'Service labour', kind: 'service', unitPriceCents: 12_500, unitLabel: 'hour' },
    {
      name: 'City mechanical permit',
      kind: 'fee',
      unitPriceCents: 7_500,
      taxable: false,
      sku: 'FEE-PERMIT',
    },
  ])
    await api(o.token, 'commands', 'product.create', { workspaceId: o.workspaceId, ...p });
  const { planId } = await api<{ planId: string }>(o.token, 'commands', 'plan.create', {
    workspaceId: o.workspaceId,
    name: 'Comfort Club',
    priceCents: 2_900,
    interval: 'month',
    includes: ['Two tune-ups a year', 'No call-out fee'],
  });
  const { personId } = await api<{ personId: string }>(o.token, 'commands', 'person.create', {
    workspaceId: o.workspaceId,
    firstName: 'Laura',
    lastName: 'Fischer',
    email: 'laura.fischer@example.test',
  });
  await api(o.token, 'commands', 'subscription.start', {
    workspaceId: o.workspaceId,
    personId,
    planId,
  });

  // ---- Products: seven columns on a desktop, a card each on a phone ----
  await page.goto(`/app/w/${o.workspaceId}/settings/payments/products`);
  const cards = page.getByTestId('products-cards');
  await expect(cards).toBeVisible();
  await expect(cards.getByTestId('product-card-City mechanical permit')).toContainText('$75');
  await expect(cards.getByTestId('product-card-City mechanical permit')).toContainText('No tax');
  await expect(cards.getByTestId('product-card-Service labour')).toContainText('per hour');
  await noSidewaysScroll(page);
  // The wide table is the desktop's, and is not what a phone renders.
  await expect(page.locator('table').first()).toBeHidden();

  // A card opens the same editor its row does.
  await cards.getByTestId('product-card-Service labour').click();
  await expect(page.getByTestId('product-editor')).toBeVisible();
  await expect(page.getByTestId('product-name')).toHaveValue('Service labour');

  // ---- Plans: two tables, both with a phone shape ----
  await page.goto(`/app/w/${o.workspaceId}/money/plans`);
  await expect(page.getByTestId('plans-cards')).toBeVisible();
  await expect(page.getByTestId('plans-table')).toBeHidden();
  await expect(page.getByTestId('plan-card-Comfort Club')).toContainText('$29 a month');
  // Nobody is billing yet: a plan waiting on the customer's card is a draft, and the recurring figure only
  // counts plans the provider is really charging.
  await expect(page.getByTestId('plan-card-Comfort Club')).toContainText('0 members');
  const who = page.getByTestId('subscriptions-cards');
  await expect(who).toBeVisible();
  await expect(page.getByTestId('subscriptions-table')).toBeHidden();
  await expect(who).toContainText('Laura Fischer');
  await expect(who).toContainText('Comfort Club');
  await noSidewaysScroll(page);

  // The row still opens the plan.
  await who.locator('a').first().click();
  await expect(page.getByTestId('plan-status')).toBeVisible();
  await noSidewaysScroll(page);

  // ---- The invoice and estimate lists keep their own phone cards ----
  for (const path of ['money', 'money/estimates', 'money/payments']) {
    await page.goto(`/app/w/${o.workspaceId}/${path}`);
    await expect(page.getByRole('heading', { name: 'Money' })).toBeVisible();
    await noSidewaysScroll(page);
  }
});

test('the editor’s sticky totals bar never covers the last row of the sheet', async ({ page }) => {
  test.setTimeout(240_000);
  const o = await moneyOwner(page, 'money-phone-bar');
  const { personId } = await api<{ personId: string }>(o.token, 'commands', 'person.create', {
    workspaceId: o.workspaceId,
    firstName: 'Rachel',
    lastName: 'Stein',
    email: 'rachel.stein@example.test',
  });
  const { estimateId } = await api<{ estimateId: string }>(o.token, 'commands', 'estimate.create', {
    workspaceId: o.workspaceId,
    personId,
    title: 'Waiting room split system',
    lines: [
      {
        name: 'Ducted split system · 3 ton',
        quantity: 1,
        unitPriceCents: 520_000,
        unitLabel: 'each',
        taxable: true,
      },
      {
        name: 'Service labour',
        quantity: 12,
        unitPriceCents: 12_500,
        unitLabel: 'hour',
        taxable: true,
      },
    ],
  });

  await page.goto(`/app/w/${o.workspaceId}/money/estimates/${estimateId}`);
  const bar = page.getByTestId('phone-totals-bar');
  const spacer = page.getByTestId('phone-totals-spacer');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('phone-total')).toContainText('$');
  await noSidewaysScroll(page);

  /** The spacer under the sheet is exactly as tall as the bar floating over it. */
  const clears = async () => {
    const [barBox, spacerBox] = await Promise.all([bar.boundingBox(), spacer.boundingBox()]);
    expect(barBox, 'the phone totals bar').not.toBeNull();
    expect(spacerBox, 'the spacer that keeps the sheet clear of it').not.toBeNull();
    expect(Math.abs(barBox!.height - spacerBox!.height)).toBeLessThanOrEqual(1);
    // And the last thing on the sheet really is above the bar.
    const last = page.locator('[data-testid="phone-totals-spacer"]').locator('xpath=..');
    await last.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    const above = await page.evaluate(() => {
      const barEl = document.querySelector('[data-testid="phone-totals-bar"]')!;
      const spacerEl = document.querySelector('[data-testid="phone-totals-spacer"]')!;
      const top = barEl.getBoundingClientRect().top;
      const content = [...document.querySelectorAll('main *, body *')].filter(
        (e) =>
          e !== spacerEl &&
          !e.contains(spacerEl) &&
          !barEl.contains(e) &&
          e !== barEl &&
          e.getBoundingClientRect().height > 20 &&
          e.compareDocumentPosition(spacerEl) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const lastEl = content[content.length - 1];
      return lastEl ? lastEl.getBoundingClientRect().bottom <= top + 1 : true;
    });
    expect(above, 'the sticky bar covers the last row of the editor').toBe(true);
  };

  await clears();

  // Opened, the bar is taller — which is the case a fixed-height spacer got wrong.
  const closedHeight = (await bar.boundingBox())!.height;
  await page.getByTestId('phone-totals-toggle').click();
  // Scoped to the bar: the desktop totals card renders the same rows, off screen at this width.
  await expect(bar.getByTestId('totals-subtotal')).toBeVisible();
  await expect
    .poll(async () => (await bar.boundingBox())!.height)
    .toBeGreaterThan(closedHeight + 20);
  // The breakdown is shown once: the bar's own big Total is right under it.
  await expect(bar.getByText('Total', { exact: true })).toHaveCount(1);
  await clears();
  await noSidewaysScroll(page);
});
