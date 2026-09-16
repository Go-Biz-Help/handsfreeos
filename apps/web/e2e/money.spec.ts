import { expect, test, type Page } from '@playwright/test';
import { api, signInOwner, WORKER } from './booking-helpers';
import { createBusiness, signUpAndConfirm } from './helpers';

/**
 * The owner's money journey, end to end through the Money section: a catalogue, an estimate written from a
 * lead, sent, approved, turned into an invoice, paid in cash — and refunded, which gives the money back without
 * ever putting it back on the bill.
 *
 * Open hours and quiet hours are pinned so the spec passes at any hour of any day — the worker's reminder and
 * nudge jobs read both, and nothing here should depend on when it runs.
 */

const BUSINESS = 'Lone Star HVAC & Roofing';
/** Open every hour of every day. */
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: '00:00', end: '24:00' }));

interface Owner {
  readonly token: string;
  readonly userId: string;
  readonly workspaceId: string;
}

type Json = Record<string, unknown>;

/**
 * Presses Copy link on a document's own page and reads back what landed on the clipboard, once the toast says
 * it was copied and what the link lets its holder do.
 */
async function copyLink(page: Page, kind: 'estimate' | 'invoice', does: string): Promise<string> {
  await page.getByTestId(`${kind}-copy-link`).click();
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Link copied' })
      .filter({ hasText: does }),
  ).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

/** One of the worker's test routes: the money jobs run now, or a customer's own link. */
const worker = async <T = Json>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`${WORKER}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json as T;
};

async function moneyOwner(page: Page, label: string): Promise<Owner> {
  const { email } = await signUpAndConfirm(page, label);
  const workspaceId = await createBusiness(page, { name: BUSINESS });
  const { token, userId } = await signInOwner(email);
  await api(token, 'commands', 'workspace.update', {
    workspaceId,
    settings: { openHours: ALL_WEEK },
  });
  await api(token, 'commands', 'phone.update_settings', {
    workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  // The business's own money settings: 8.25% sales tax, Net 14, a 25% deposit and 14-day estimates.
  await api(token, 'commands', 'money.save_settings', {
    workspaceId,
    settings: {
      tax: { rateBp: 825, name: 'TX sales tax', newProductsTaxable: true },
      terms: 'net_14',
      estimateGoodForDays: 14,
      deposit: { kind: 'percent', percentBp: 2_500, amountCents: 0 },
      numbering: {
        estimate: { prefix: 'EST-', next: 1001, pad: 4 },
        invoice: { prefix: 'INV-', next: 1001, pad: 4 },
      },
    },
  });
  return { token, userId, workspaceId };
}

test('Money: a catalogue, an estimate from a lead, sent, approved, invoiced, paid and refunded', async ({
  page,
  browser,
  context,
}) => {
  test.setTimeout(300_000);
  // Copy link writes to the clipboard, and the spec reads it back.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const o = await moneyOwner(page, 'money');

  // The catalogue: a taxable part and labour the business does not charge tax on.
  await api(o.token, 'commands', 'product.create', {
    workspaceId: o.workspaceId,
    name: '3-ton AC system',
    sku: 'AC-3T-16',
    kind: 'product',
    unitPriceCents: 640_000,
    unitLabel: 'each',
    taxable: true,
  });
  await api(o.token, 'commands', 'product.create', {
    workspaceId: o.workspaceId,
    name: 'Labor',
    sku: 'LAB-STD',
    kind: 'service',
    unitPriceCents: 14_500,
    unitLabel: 'hour',
    taxable: false,
  });

  const { personId } = await api<{ personId: string }>(o.token, 'commands', 'person.create', {
    workspaceId: o.workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: 'maria.lopez@example.test',
  });
  const { leadId } = await api<{ leadId: string }>(o.token, 'commands', 'lead.create', {
    workspaceId: o.workspaceId,
    personId,
    title: 'New AC install',
    valueCents: 1_850_000,
  });

  // The section itself: the headline strip, the four chips, and nothing owed yet.
  await page.goto(`/app/w/${o.workspaceId}/money`);
  await expect(page.getByTestId('money-outstanding-value')).toHaveText('$0');
  await expect(page.getByTestId('money-overdue-value')).toHaveText('$0');
  await expect(page.getByTestId('money-tab-invoices')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('invoices-table')).toBeHidden();

  // A new estimate, opened from the lead: the customer and the job are already filled in.
  await page.goto(`/app/w/${o.workspaceId}/money/estimates/new?lead=${leadId}`);
  await expect(page.getByText('Maria Lopez').first()).toBeVisible();
  await expect(page.getByTestId('document-title')).toHaveValue('New AC install');

  // Two lines from the catalogue, with the prices and the taxability they were given.
  await page.getByTestId('line-catalogue').click();
  await page.getByTestId('product-option-3-ton AC system').click();
  await page.getByTestId('line-catalogue').click();
  await page.getByTestId('product-option-Labor').click();
  const labor = page.getByTestId('line-row-Labor');
  await labor.getByLabel('How many').fill('16');
  await labor.getByLabel('How many').blur();

  // 10% off the whole job, shared over the lines before tax.
  await page.getByTestId('discount-kind').selectOption('percent');
  await page.getByTestId('discount-percent').fill('10');
  await page.getByTestId('discount-percent').blur();

  // $6,400 + 16 × $145 = $8,720, less $872, tax on the taxable line's $5,760 only.
  await expect(page.getByTestId('totals-subtotal-value').first()).toHaveText('$8,720');
  await expect(page.getByTestId('totals-discount-value').first()).toHaveText('−$872');
  await expect(page.getByTestId('totals-tax-value').first()).toHaveText('$475.20');
  await expect(page.getByTestId('totals-total-value').first()).toHaveText('$8,323.20');
  // A quarter up front, the rest when the job is done.
  await expect(page.getByTestId('deposit-amount-shown')).toHaveText('$2,080.80');
  await expect(page.getByTestId('deposit-balance-value')).toHaveText('$6,242.40');

  await page.getByTestId('document-save').click();
  await expect(page.getByTestId('document-saved')).toContainText('all changes saved');
  await expect(page).toHaveURL(/\/money\/estimates\/[0-9a-f-]{36}$/);
  const estimatePath = new URL(page.url()).pathname;

  // Reloaded, the deposit still reads as the quarter it was written as, not as the cents it came to.
  await page.reload();
  await expect(page.getByTestId('deposit-percent')).toHaveValue('25');
  await expect(page.getByTestId('deposit-amount-shown')).toHaveText('$2,080.80');
  await expect(page.getByTestId('totals-total-value').first()).toHaveText('$8,323.20');

  // Sending takes the number, freezes the document and hands over to its own page.
  await page.getByTestId('document-send').click();
  await expect(page.getByTestId('send-dialog')).toBeVisible();
  await page.getByTestId('send-confirm').click();
  await expect(page.getByTestId('document-status')).toHaveText('Sent');
  await expect(page.getByRole('heading', { name: 'EST-1001' })).toBeVisible();
  await expect(page.getByTestId('document-activity')).toContainText('Sent to Maria Lopez');
  await expect(page.getByTestId('document-line')).toHaveCount(2);

  // Copy link: the very link she was sent, to paste anywhere, and it opens her own page signed out.
  const estimateLink = await copyLink(
    page,
    'estimate',
    'Anyone with this link can see and approve',
  );
  expect(estimateLink).toMatch(/^http:\/\/localhost:3000\/e\/[0-9A-Za-z]{18}$/);
  const hers = await browser.newContext();
  const herEstimate = await hers.newPage();
  await herEstimate.goto(estimateLink);
  await expect(herEstimate.getByTestId('estimate-hero')).toContainText('$8,323.20');
  await expect(herEstimate.getByTestId('approve-open')).toBeVisible();
  await hers.close();

  // She says yes on the phone, and the estimate records it in her name.
  await page.getByTestId('estimate-accepted').click();
  await page.getByTestId('accepted-confirm').click();
  await expect(page.getByTestId('document-status')).toHaveText('Approved');
  await expect(page.getByTestId('document-activity')).toContainText('Approved by Maria Lopez');

  // One press turns it into the invoice that collects the money.
  await page.getByTestId('estimate-convert').click();
  await page.getByTestId('convert-confirm').click();
  await expect(page).toHaveURL(/\/money\/invoices\/[0-9a-f-]{36}$/);
  const invoicePath = new URL(page.url()).pathname;
  const invoiceId = invoicePath.split('/').pop()!;
  await expect(page.getByTestId('document-status')).toHaveText('Draft');
  await expect(page.getByTestId('totals-total-value').first()).toHaveText('$8,323.20');

  // The invoice goes out, then the money comes in as cash.
  await page.getByTestId('document-send').click();
  await page.getByTestId('send-confirm').click();
  await expect(page.getByTestId('document-status')).toHaveText('Sent');
  await expect(page.getByRole('heading', { name: 'INV-1001' })).toBeVisible();
  const invoiceLink = await copyLink(
    page,
    'invoice',
    'Anyone with this link can pay this invoice.',
  );
  expect(invoiceLink).toMatch(/^http:\/\/localhost:3000\/i\/[0-9A-Za-z]{18}$/);
  // Exactly the link the messages send, not a second one that would have to be retired separately.
  expect(invoiceLink).toBe(
    (await worker<{ url: string }>('/test/money/link', { workspaceId: o.workspaceId, invoiceId }))
      .url,
  );

  await page.getByTestId('invoice-record-payment').click();
  await expect(page.getByTestId('cash-dialog')).toBeVisible();
  await page.getByTestId('cash-confirm').click();
  await expect(page.getByTestId('document-status')).toHaveText('Paid');
  await expect(page.getByTestId('totals-balance-value')).toHaveText('$0');
  await expect(page.getByTestId('invoice-payments')).toContainText('$8,323.20');

  // And the section says so: nothing outstanding, and the payment on the Payments tab.
  await page.goto(`/app/w/${o.workspaceId}/money`);
  await expect(page.getByTestId('money-outstanding-value')).toHaveText('$0');
  await expect(page.getByTestId('money-collected-value')).toHaveText('$8,323');
  await expect(page.getByTestId('invoice-row-INV-1001')).toContainText('Paid');

  await page.getByTestId('money-tab-estimates').click();
  await expect(page.getByTestId('estimate-row-EST-1001')).toContainText('Approved');

  await page.getByTestId('money-tab-payments').click();
  await expect(page.getByTestId('payments-table')).toContainText('$8,323.20');
  await expect(page.getByTestId('payments-table')).toContainText('Cash');

  // ---- All of it given back: the money goes back, and nothing goes back on the bill ----
  await page.goto(invoicePath);
  await page.getByTestId('invoice-payments').getByTestId('payment-refund').click();
  await expect(page.getByTestId('refund-dialog')).toBeVisible();
  await page.getByTestId('refund-confirm').click();
  await expect(page.locator('[data-sonner-toast]').getByText('$8,323.20 refunded.')).toBeVisible();
  // Cash goes back by hand, so the worker settles the refund itself; run its jobs rather than wait on them.
  await expect
    .poll(
      async () => {
        await worker('/test/money/run-due', { workspaceId: o.workspaceId });
        const got = await api<{ invoice: { state: string } }>(o.token, 'queries', 'invoice.get', {
          workspaceId: o.workspaceId,
          invoiceId,
        });
        return got.invoice.state;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe('refunded');
  await page.reload();
  await expect(page.getByTestId('document-status')).toHaveText('Refunded');
  await expect(page.getByTestId('totals-balance-value')).toHaveText('$0');
  await expect(page.getByTestId('totals-refunded-value')).toHaveText('$8,323.20');
  await expect(page.getByTestId('document-activity')).toContainText('$8,323.20 refunded on');
  // Nothing is owed, so there is nothing to record; and with every cent back, it can be voided and reissued.
  await expect(page.getByTestId('invoice-record-payment')).toHaveCount(0);
  await expect(page.getByTestId('document-void')).toBeVisible();

  // The section adds up: nothing outstanding, nothing collected once the refund is taken off.
  await page.goto(`/app/w/${o.workspaceId}/money`);
  await expect(page.getByTestId('money-outstanding-value')).toHaveText('$0');
  await expect(page.getByTestId('money-collected-value')).toHaveText('$0');
  await expect(page.getByTestId('money-collected')).toContainText('after $8,323.20 refunded');
  await expect(page.getByTestId('invoice-row-INV-1001').getByTestId('invoice-status')).toHaveText(
    'Refunded',
  );
  // Not "Paid" anywhere on the row, the Due column included.
  await expect(page.getByTestId('invoice-row-INV-1001')).not.toContainText('Paid');
  // And under the estimate it came from, where it used to read "Paid" whatever went back.
  await page.goto(estimatePath);
  await expect(
    page.getByTestId('estimate-invoices').getByTestId('estimate-invoice-status'),
  ).toHaveText('Refunded');

  // The customer's own page, from the link copied earlier and signed out: the refund leads, and there is no
  // way to pay it again.
  const signedOut = await browser.newContext();
  const theirs = await signedOut.newPage();
  await theirs.goto(invoiceLink);
  await expect(theirs.getByTestId('invoice-refunded')).toContainText(
    /^Refunded\. \$8,323\.20 went back to you on \w{3}, \w{3} \d{1,2}\.$/,
  );
  await expect(theirs.getByTestId('invoice-paid')).toHaveCount(0);
  await expect(theirs.getByTestId('money-due')).toContainText('Nothing left to pay');
  await expect(theirs.getByTestId('pay')).toHaveCount(0);
  await signedOut.close();
});

/**
 * A sent document is frozen and a stale save is refused. Both are checked against the API, because the editor
 * only ever offers them on a draft — which is the point.
 */
test('Money: a sent estimate is frozen, and a stale save is refused', async ({ page }) => {
  test.setTimeout(180_000);
  const o = await moneyOwner(page, 'money-frozen');
  const { personId } = await api<{ personId: string }>(o.token, 'commands', 'person.create', {
    workspaceId: o.workspaceId,
    firstName: 'Sam',
    lastName: 'Patel',
    email: 'sam.patel@example.test',
  });
  const line = {
    productId: null,
    name: 'Mini split',
    description: null,
    quantity: 1,
    unitLabel: 'each',
    unitPriceCents: 424_500,
    taxable: true,
    discountCents: 0,
  };
  const made = await api<{ estimateId: string; revision: number }>(
    o.token,
    'commands',
    'estimate.create',
    { workspaceId: o.workspaceId, personId, title: 'Mini split · garage', lines: [line] },
  );

  // The editor loads the draft; a save from somewhere else moves the revision on underneath it.
  await page.goto(`/app/w/${o.workspaceId}/money/estimates/${made.estimateId}`);
  await expect(page.getByTestId('line-row-Mini split')).toBeVisible();
  await api(o.token, 'commands', 'estimate.update', {
    workspaceId: o.workspaceId,
    estimateId: made.estimateId,
    personId,
    title: 'Mini split · garage and shop',
    lines: [line, { ...line, name: 'Second head', unitPriceCents: 89_000 }],
    baseRevision: made.revision,
  });

  await page.getByTestId('document-title').fill('Mini split · garage only');
  await page.getByTestId('document-save').click();
  await expect(page.getByText('Someone saved this estimate while you were editing.')).toBeVisible();
  await page.getByTestId('document-reload').click();
  await expect(page.getByTestId('document-title')).toHaveValue('Mini split · garage and shop');

  // Once it has gone out it is a document, not a form: the editor is gone and the number is fixed.
  await page.getByTestId('document-send').click();
  await page.getByTestId('send-confirm').click();
  await expect(page.getByTestId('document-status')).toHaveText('Sent');
  await expect(page.getByTestId('document-title')).toBeHidden();
  await expect(page.getByTestId('document-view')).toBeVisible();
});
