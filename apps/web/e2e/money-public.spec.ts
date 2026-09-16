import { expect, test, type Browser, type Page } from '@playwright/test';
import { api, ownerWithSite, WORKER, type Owner } from './booking-helpers';

/**
 * The customer's own money pages, signed out: `/e/<token>` (design/m9 Estimate.dc.html) and `/i/<token>`
 * (Invoice.dc.html).
 *
 * Everything the business does is set up through API commands with the owner's token — this spec must not
 * depend on the Money section or Settings → Payments, which other helpers are building. The customer always
 * browses in a **fresh context with no session**, because that is the only way these pages are ever opened.
 *
 * Paying runs against the stand-in provider (apps/worker/src/payments/fake.ts) through its own payment page,
 * which stands where Stripe's Payment Element or Square's Web Payments SDK would: the Stripe stand-in confirms
 * an intent in the browser, the Square stand-in tokenises a card and the worker charges it. A bank transfer is
 * never instant, so it is settled on purpose through `POST /test/money/provider-event`, which makes the
 * stand-in post its properly signed webhook at us.
 */

/** The stand-in's numbers (apps/worker/src/payments/fake.ts). */
const CARD_OK = '4242424242424242';
const CARD_DECLINED = '4000000000000002';
const BANK_OK = '000123456789';

/** The canvas's figures, which add up: $9,009 less 10%, tax on two of the three lines, total $8,604.76. */
const LINES = [
  {
    name: '3-ton AC system · 16 SEER2',
    description: 'Carrier, 10-year parts warranty',
    quantity: 1,
    unitLabel: 'each',
    unitPriceCents: 640_000,
    taxable: true,
  },
  {
    name: 'Labor',
    description: 'Two techs, one day',
    quantity: 16,
    unitLabel: 'hours',
    unitPriceCents: 14_500,
    taxable: false,
  },
  {
    name: 'Smart thermostat',
    description: 'Installed and set up on her wi-fi',
    quantity: 1,
    unitLabel: 'each',
    unitPriceCents: 28_900,
    taxable: true,
  },
];
const TOTAL = '$8,604.76';
const DEPOSIT_CENTS = 215_119;
const BALANCE = '$6,453.57';

type Json = Record<string, unknown>;

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

/**
 * Signs a stand-in payment account in without going near Settings → Payments (another helper's page): the
 * one-time state from the command, the worker's own start route, then the stand-in's approve page.
 */
async function connectAccount(
  owner: Owner,
  provider: 'stripe' | 'square',
  accountId: string,
): Promise<void> {
  const { state } = await api<{ connectionId: string; state: string }>(
    owner.token,
    'commands',
    'payment_connection.connect',
    { workspaceId: owner.workspaceId, provider, environment: 'test' },
  );
  const start = await fetch(
    `${WORKER}/oauth/${provider}/start?state=${encodeURIComponent(state)}`,
    { redirect: 'manual' },
  );
  const authorize = start.headers.get('location');
  if (!authorize) throw new Error(`no provider sign-in to follow (${start.status})`);
  // The stand-in's own page is a form; its approve route is the same address with the seller's answer on it.
  const approve = new URL(authorize.replace('/authorize', '/approve'));
  approve.searchParams.set('account', accountId);
  approve.searchParams.set('decision', 'allow');
  const approved = await fetch(approve, { redirect: 'manual' });
  const callback = approved.headers.get('location');
  if (!callback) throw new Error(`the stand-in refused the sign-in (${approved.status})`);
  await fetch(callback, { redirect: 'manual' });
  await expect
    .poll(
      async () =>
        (
          await api<{ connections: { provider: string; status: string }[] }>(
            owner.token,
            'queries',
            'payment_connection.list',
            { workspaceId: owner.workspaceId },
          )
        ).connections.find((c) => c.provider === provider)?.status,
    )
    .toBe('active');
}

/** Tax, numbering and a deposit, so the pages read like the canvas. */
async function moneySettings(owner: Owner): Promise<void> {
  await api(owner.token, 'commands', 'money.save_settings', {
    workspaceId: owner.workspaceId,
    settings: {
      tax: { rateBp: 825, name: 'TX sales tax' },
      numbering: {
        estimate: { prefix: 'EST-', next: 1042 },
        invoice: { prefix: 'INV-', next: 1042 },
      },
      deposit: { kind: 'percent', percentBp: 2500 },
      bankTransfer: true,
    },
  });
}

/** A business with money set up, an account to be paid into, and a customer on its books. */
async function moneyOwner(
  page: Page,
  label: string,
  business: string,
  provider: 'stripe' | 'square',
): Promise<Owner & { personId: string }> {
  const owner = await ownerWithSite(page, label, business);
  await moneySettings(owner);
  await connectAccount(owner, provider, `${provider === 'stripe' ? 'acct' : 'merchant'}_${label}`);
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: `maria-${label}@hfos.test`,
  });
  return { ...owner, personId };
}

/** The customer's own link for a document — the one the texts and emails will carry. */
const linkFor = async (
  owner: Owner,
  document: { estimateId: string } | { invoiceId: string },
): Promise<string> =>
  (
    await worker<{ token: string }>('/test/money/link', {
      workspaceId: owner.workspaceId,
      ...document,
    })
  ).token;

async function sendEstimate(
  owner: Owner & { personId: string },
  title: string,
  notes?: string,
): Promise<{ estimateId: string; token: string }> {
  const { estimateId } = await api<{ estimateId: string }>(
    owner.token,
    'commands',
    'estimate.create',
    {
      workspaceId: owner.workspaceId,
      personId: owner.personId,
      title,
      notes: notes ?? null,
      lines: LINES,
      discount: { kind: 'percent', percentBp: 1000 },
    },
  );
  await api(owner.token, 'commands', 'estimate.send', {
    workspaceId: owner.workspaceId,
    estimateId,
    channels: ['email'],
  });
  return { estimateId, token: await linkFor(owner, { estimateId }) };
}

/** An estimate turned into an invoice with its deposit already paid, exactly as the canvas draws it. */
async function sentInvoiceWithDeposit(
  owner: Owner & { personId: string },
  title: string,
): Promise<{ invoiceId: string; token: string }> {
  const { estimateId } = await sendEstimate(owner, title);
  const { invoiceId } = await api<{ invoiceId: string }>(
    owner.token,
    'commands',
    'estimate.convert',
    {
      workspaceId: owner.workspaceId,
      estimateId,
    },
  );
  await api(owner.token, 'commands', 'invoice.send', {
    workspaceId: owner.workspaceId,
    invoiceId,
    channels: ['email'],
  });
  await api(owner.token, 'commands', 'invoice.record_cash_payment', {
    workspaceId: owner.workspaceId,
    invoiceId,
    amountCents: DEPOSIT_CENTS,
    method: 'check',
  });
  return { invoiceId, token: await linkFor(owner, { invoiceId }) };
}

const estimateOf = async (owner: Owner, estimateId: string) =>
  (
    await api<{
      estimate: {
        status: string;
        firstViewedAt: string | null;
        acceptedName: string | null;
        acceptedVia: string | null;
        acceptedWording: string | null;
        declinedReason: string | null;
      };
    }>(owner.token, 'queries', 'estimate.get', { workspaceId: owner.workspaceId, estimateId })
  ).estimate;

const invoiceStatusOf = async (owner: Owner, invoiceId: string) =>
  (
    await api<{ invoice: { status: string; balanceCents: number; amountPaidCents: number } }>(
      owner.token,
      'queries',
      'invoice.get',
      { workspaceId: owner.workspaceId, invoiceId },
    )
  ).invoice;

/** A customer's browser: no session, nothing carried over from the owner's. */
const customerPage = async (browser: Browser): Promise<Page> =>
  (await browser.newContext()).newPage();

/** Pays at the stand-in's page, which is where a real provider's fields would be. */
async function payAtProvider(
  customer: Page,
  opts: { instrument: string; method?: 'card' | 'ach'; cancel?: boolean },
): Promise<{ intentId: string | null }> {
  await customer.waitForURL(/\/payments\/fake\/pay/);
  const intentId = new URL(customer.url()).searchParams.get('intent');
  await expect(customer.getByTestId('fake-pay')).toBeVisible();
  if (opts.cancel) {
    await customer.getByTestId('fake-cancel').click();
    return { intentId };
  }
  const choice = customer.locator(`input[name="method"][value="${opts.method ?? 'card'}"]`);
  if (await choice.count()) await choice.check();
  await customer.locator('#instrument').fill(opts.instrument);
  await customer.getByTestId('fake-pay').click();
  return { intentId };
}

test('The estimate page: read it, approve it with a typed name, decline another, and a link that doesn’t work', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const owner = await moneyOwner(page, 'money-estimate', 'Lone Star HVAC & Roofing', 'stripe');
  // The sentence names this estimate's own figure and this business: `acceptanceWording` renders it, and the
  // page and the stored evidence both have to be exactly this.
  const WORDING = `By typing my name I approve this estimate for ${TOTAL} from Lone Star HVAC & Roofing.`;
  const { estimateId, token } = await sendEstimate(
    owner,
    'New AC install · 3-ton system',
    'Price holds for 14 days. We can start the week of September 28.',
  );

  const customer = await customerPage(browser);
  await customer.goto(`/e/${token}`);
  await expect(customer.getByTestId('estimate-page')).toBeVisible();

  // The business on top, the total at the top, the lines as they were written.
  await expect(customer.getByTestId('business-name')).toHaveText('Lone Star HVAC & Roofing');
  await expect(customer.getByTestId('money-headline')).toHaveText(TOTAL);
  await expect(customer.getByTestId('estimate-hero')).toContainText('New AC install');
  await expect(customer.getByTestId('money-line')).toHaveCount(3);
  await expect(customer.getByTestId('money-document')).toContainText('EST-1042');
  await expect(customer.getByTestId('money-document')).toContainText(
    'Carrier, 10-year parts warranty',
  );
  await expect(customer.getByTestId('money-document')).toContainText('16 hours × $145 · no tax');
  await expect(customer.getByTestId('money-tax')).toContainText(
    'TX sales tax · 8.25% on $6,020.10',
  );
  await expect(customer.getByTestId('money-discount-value')).toHaveText('−$900.90');
  await expect(customer.getByTestId('money-total-value')).toHaveText(TOTAL);
  await expect(customer.getByTestId('money-deposit-value')).toHaveText('$2,151.19');
  await expect(customer.getByTestId('money-document')).toContainText(
    'Balance when the work is done',
  );
  await expect(customer.getByTestId('money-notes')).toContainText('Price holds for 14 days.');
  // Nothing a customer sees ever says what a way of paying costs the business.
  await expect(customer.getByTestId('estimate-page')).not.toContainText(/fee|surcharge|costs us/i);

  // Opening it is news for the business, and it happened without anybody pressing anything.
  await expect.poll(async () => (await estimateOf(owner, estimateId)).firstViewedAt).not.toBeNull();

  // Approving: the sheet shows the total and the exact sentence that gets stored with it.
  await customer.getByTestId('approve-open').click();
  await expect(customer.getByTestId('approve-sheet')).toBeVisible();
  await expect(customer.getByTestId('approve-sheet')).toContainText(TOTAL);
  await expect(customer.getByTestId('approve-wording')).toHaveText(WORDING);

  // Any name is taken: people type "Maria L.".
  await customer.getByTestId('approve-name').fill('Maria L.');
  await customer.getByTestId('approve').click();

  await expect(customer.getByTestId('estimate-approved')).toContainText('Approved.');
  await expect(customer.getByTestId('estimate-approved')).toContainText('Maria L.');
  await expect(customer.getByTestId('estimate-approved')).toContainText('maria-money-estimate');
  await expect(customer.getByTestId('estimate-body')).toContainText('What happens next');
  await expect(customer.getByTestId('approve-open')).toHaveCount(0);

  // What was stored is what she saw: her words, our words, and the link as the way it was answered.
  const answered = await estimateOf(owner, estimateId);
  expect(answered.status).toBe('accepted');
  expect(answered.acceptedName).toBe('Maria L.');
  expect(answered.acceptedVia).toBe('link');
  expect(answered.acceptedWording).toBe(WORDING);

  // Opened again, it reads as answered rather than offering the buttons a second time.
  await customer.reload();
  await expect(customer.getByTestId('estimate-approved')).toBeVisible();
  await expect(customer.getByTestId('approve-open')).toHaveCount(0);

  // ---- a second estimate, declined ----
  const second = await sendEstimate(owner, 'Duct replacement');
  await customer.goto(`/e/${second.token}`);
  await customer.getByTestId('decline-open').click();
  await expect(customer.getByTestId('decline-sheet')).toBeVisible();
  await customer.getByTestId('decline-reason').fill('Going with someone cheaper, sorry.');
  await customer.getByTestId('decline').click();
  await expect(customer.getByTestId('estimate-declined')).toContainText('Declined.');
  const declined = await estimateOf(owner, second.estimateId);
  expect(declined.status).toBe('declined');
  expect(declined.declinedReason).toBe('Going with someone cheaper, sorry.');

  // ---- a link that isn't one ----
  await customer.goto(`/e/${token.slice(0, 8)}0000000000`);
  await expect(customer.getByTestId('link-missing')).toContainText('This link doesn’t work');
});

test('The invoice page: bank transfer first, a card declined and then taken, and the receipt after', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await moneyOwner(page, 'money-card', 'Lone Star Card HVAC', 'square');
  const { invoiceId, token } = await sentInvoiceWithDeposit(owner, 'New AC install · 3-ton system');

  const customer = await customerPage(browser);
  await customer.goto(`/i/${token}`);
  await expect(customer.getByTestId('invoice-page')).toBeVisible();

  // The big number is what is owed today: the deposit is already off it.
  await expect(customer.getByTestId('money-headline')).toHaveText(BALANCE);
  await expect(customer.getByTestId('money-total-value')).toHaveText(TOTAL);
  await expect(customer.getByTestId('money-paid-value')).toHaveText('−$2,151.19');
  await expect(customer.getByTestId('money-due-value')).toHaveText(BALANCE);
  await expect(customer.getByTestId('invoice-hero')).toContainText('Due ');

  // Bank transfer leads and card follows — and nothing says what either costs the business.
  const methods = customer.getByTestId('pay-methods');
  await expect(methods.getByRole('radio')).toHaveCount(2);
  await expect(methods.getByRole('radio').first()).toContainText('Bank transfer');
  await expect(methods.getByRole('radio').nth(1)).toContainText('Card');
  await expect(customer.getByTestId('pay-method-ach')).toHaveAttribute('data-on', 'yes');
  await expect(customer.getByTestId('invoice-page')).not.toContainText(
    /fee|surcharge|1%|2\.9%|costs us|cheapest/i,
  );
  await expect(customer.getByTestId('pay')).toHaveText(`Pay ${BALANCE} by bank transfer`);

  // It prints without the things that only belong on a screen.
  await customer.emulateMedia({ media: 'print' });
  await expect(customer.getByTestId('money-document')).toBeVisible();
  await expect(customer.getByTestId('pay')).toBeHidden();
  await expect(customer.getByTestId('print')).toBeHidden();
  await customer.emulateMedia({ media: 'screen' });

  // Changing her mind at the provider brings her back with nothing charged.
  await customer.getByTestId('pay-method-card').click();
  await expect(customer.getByTestId('pay')).toHaveText(`Pay ${BALANCE} by card`);
  await customer.getByTestId('pay').click();
  await payAtProvider(customer, { instrument: CARD_OK, method: 'card', cancel: true });
  await expect(customer.getByTestId('pay-notice')).toContainText('nothing was charged');
  expect((await invoiceStatusOf(owner, invoiceId)).balanceCents).toBe(645_357);

  // A card that is refused is an answer, not an error: plain words, and she can try again.
  await customer.getByTestId('pay-method-card').click();
  await customer.getByTestId('pay').click();
  await payAtProvider(customer, { instrument: CARD_DECLINED, method: 'card' });
  await expect(customer.getByTestId('pay-declined')).toContainText('declined');
  await expect(customer.getByTestId('pay-declined')).toContainText('Nothing was charged');
  await expect(customer.getByTestId('pay')).toBeVisible();

  // And once it goes through, the page is a receipt.
  await customer.getByTestId('pay-method-card').click();
  await customer.getByTestId('pay').click();
  await payAtProvider(customer, { instrument: CARD_OK, method: 'card' });
  await expect(customer.getByTestId('invoice-paid')).toContainText(
    'Paid in full. Thank you, Maria.',
  );
  await expect(customer.getByTestId('receipt-total-value')).toHaveText(TOTAL);
  await expect(customer.getByTestId('invoice-receipt')).toContainText('Card');
  await expect(customer.getByTestId('receipt-reference-value')).toHaveText('INV-1042');
  await expect(customer.getByTestId('pay')).toHaveCount(0);

  const paid = await invoiceStatusOf(owner, invoiceId);
  expect(paid.status).toBe('paid');
  expect(paid.balanceCents).toBe(0);

  // Opened again later, it is still the receipt and there is nothing left to pay.
  await customer.reload();
  await expect(customer.getByTestId('invoice-paid')).toBeVisible();
  await expect(customer.getByTestId('invoice-receipt')).toBeVisible();
  await expect(customer.getByTestId('pay')).toHaveCount(0);
  await expect(customer.getByTestId('pay-methods')).toHaveCount(0);
});

test('The invoice page: a bank transfer is on its way for days, then settles', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const owner = await moneyOwner(page, 'money-bank', 'Lone Star Bank HVAC', 'stripe');
  const { invoiceId, token } = await sentInvoiceWithDeposit(owner, 'New AC install · 3-ton system');

  const customer = await customerPage(browser);
  await customer.goto(`/i/${token}`);
  await expect(customer.getByTestId('pay-method-ach')).toHaveAttribute('data-on', 'yes');
  await customer.getByTestId('pay').click();
  const { intentId } = await payAtProvider(customer, { instrument: BANK_OK, method: 'ach' });
  expect(intentId).toBeTruthy();

  // Nothing is paid yet, and the page says so in the customer's terms rather than calling her late.
  await expect(customer.getByTestId('invoice-settling')).toContainText(
    `${BALANCE} is on its way by bank transfer`,
  );
  await expect(customer.getByTestId('invoice-settling')).toContainText('1 to 3 business days');
  await expect(customer.getByTestId('money-settling-value')).toHaveText(BALANCE);
  await expect(customer.getByTestId('pay')).toHaveCount(0);
  expect((await invoiceStatusOf(owner, invoiceId)).balanceCents).toBe(645_357);

  // Days later the bank lands it: the stand-in posts the signed webhook a real provider would.
  const settled = await worker<{ webhooks: { ok: boolean }[] }>('/test/money/provider-event', {
    workspaceId: owner.workspaceId,
    paymentId: intentId,
    event: 'settle',
  });
  expect(settled.webhooks.some((w) => w.ok)).toBe(true);
  await expect.poll(async () => (await invoiceStatusOf(owner, invoiceId)).status).toBe('paid');

  await customer.reload();
  await expect(customer.getByTestId('invoice-paid')).toContainText('Paid in full');
  await expect(customer.getByTestId('invoice-receipt')).toContainText('Bank transfer');
  await expect(customer.getByTestId('receipt-total-value')).toHaveText(TOTAL);
  await expect(customer.getByTestId('pay')).toHaveCount(0);
});
