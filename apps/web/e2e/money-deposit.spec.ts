import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  api,
  makeCalendar,
  ownerWithSite,
  randomPhone,
  WORKER,
  type Owner,
} from './booking-helpers';

/**
 * A deposit taken when a customer books (design/m9/Booking.dc.html).
 *
 * The rule Chris approved, and the one this spec is really about: **a card is held, not charged, until the
 * time is confirmed**. The customer sees what the visit costs, what is due now and what is left for after,
 * pays through the stand-in provider, and lands on "You're booked" with the deposit shown. The business's own
 * side is read through the API, because the appointment sheet and the calendar badge belong to another step.
 *
 * The second test is the calendar builder's Payments module saving a share of the price and an account.
 */

/** The stand-in's numbers (apps/worker/src/payments/fake.ts). */
const CARD_OK = '4242 4242 4242 4242';
const PRICE = 45_000;
const DEPOSIT = '$112.50';
const AFTER = '$337.50';

type Json = Record<string, unknown>;

/** Signs a stand-in payment account in without going near Settings → Payments (another helper's page). */
async function connectAccount(
  owner: Owner,
  provider: 'stripe' | 'square',
  accountId: string,
): Promise<string> {
  const { state, connectionId } = await api<{ connectionId: string; state: string }>(
    owner.token,
    'commands',
    'payment_connection.connect',
    { workspaceId: owner.workspaceId, provider, environment: 'test' },
  );
  const start = await fetch(
    `${WORKER}/oauth/${provider}/start?state=${encodeURIComponent(state)}`,
    {
      redirect: 'manual',
    },
  );
  const authorize = start.headers.get('location');
  if (!authorize) throw new Error(`no provider sign-in to follow (${start.status})`);
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
          await api<{ connections: { id: string; status: string }[] }>(
            owner.token,
            'queries',
            'payment_connection.list',
            { workspaceId: owner.workspaceId },
          )
        ).connections.find((c) => c.id === connectionId)?.status,
    )
    .toBe('active');
  return connectionId;
}

/** The business asks for a quarter up front, as the canvas does. */
const moneySettings = (owner: Owner) =>
  api(owner.token, 'commands', 'money.save_settings', {
    workspaceId: owner.workspaceId,
    settings: {
      tax: { rateBp: 825, name: 'TX sales tax' },
      numbering: { invoice: { prefix: 'INV-', next: 1042 } },
      deposit: { kind: 'percent', percentBp: 2500 },
      bankTransfer: false,
    },
  });

/** A priced service, so a percentage has something to be a percentage of. */
async function pricedService(owner: Owner, name: string): Promise<string> {
  const { serviceId } = await api<{ serviceId: string }>(
    owner.token,
    'commands',
    'service.create',
    {
      workspaceId: owner.workspaceId,
      name,
      durations: [180],
      priceCents: PRICE,
    },
  );
  return serviceId;
}

async function fillDetails(c: Page, name: string) {
  await expect(c.getByRole('heading', { name: 'Your details' })).toBeVisible();
  await c.getByLabel('Name', { exact: true }).fill(name);
  await c.getByLabel('Mobile', { exact: true }).fill(randomPhone());
  await c.getByLabel('Email', { exact: true }).fill(`${randomUUID().slice(0, 8)}@hfos.test`);
}

test('a customer pays a deposit to hold their time, and it shows on the booking', async ({
  page,
  browser,
}) => {
  const owner = await ownerWithSite(page, 'deposit-owner', 'Lone Star Deposit HVAC');
  await moneySettings(owner);
  await connectAccount(owner, 'stripe', `acct_dep_${randomUUID().slice(0, 8)}`);
  const serviceId = await pricedService(owner, 'Duct cleaning');
  const cal = await makeCalendar(owner, 'Duct cleaning', {
    services: { mode: 'one', items: [{ serviceId }] },
    payments: { mode: 'deposit' },
  });

  const customer = await browser.newContext({ viewport: { width: 1280, height: 832 } });
  const c = await customer.newPage();
  await c.goto(cal.path);

  // The price and the deposit are said before anyone types anything.
  const first = c.getByTestId('slot').first();
  await expect(first).toBeVisible();
  const picked = (await first.textContent())!.trim();
  await first.click();
  await c.getByRole('button', { name: `Continue with ${picked}` }).click();
  await fillDetails(c, 'David Kim');
  await expect(c.getByTestId('payment-ahead')).toContainText(`A ${DEPOSIT} deposit is due to book`);
  await c.getByRole('button', { name: 'Continue to payment' }).click();

  // The pay step: what the visit costs, what is due now, and what is left for after.
  const pay = c.getByTestId('deposit-step');
  await expect(
    c.getByRole('heading', { name: `A ${DEPOSIT} deposit is due to book` }),
  ).toBeVisible();
  await expect(pay).toContainText('Duct cleaning');
  await expect(pay).toContainText('Deposit due now');
  await expect(pay).toContainText(DEPOSIT);
  await expect(pay).toContainText('Due after the visit');
  await expect(pay).toContainText(AFTER);
  await expect(pay).toContainText('held, not charged, until the time is confirmed');

  // The provider's own page stands where Stripe's Payment Element would.
  await c.getByTestId('pay-deposit').click();
  await expect(c.getByTestId('fake-pay')).toBeVisible();
  await c.locator('#instrument').fill(CARD_OK.replace(/\s/g, ''));
  await c.getByTestId('fake-pay').click();

  // Back on our own page, booked, with the deposit on it.
  await expect(c.getByRole('heading', { name: 'You’re booked' })).toBeVisible();
  await expect(c).toHaveURL(/\/hold\//);
  await expect(c.getByTestId('deposit-paid')).toHaveText(DEPOSIT);
  await expect(c.getByTestId('deposit-after')).toHaveText(AFTER);
  await expect(c.getByTestId('booked')).toContainText('Visa •••• 4242');

  // The business's side: one deposit invoice, numbered, paid, and linked to the seat it holds.
  const { invoices } = await api<{
    invoices: {
      id: string;
      status: string;
      purpose: string;
      origin: string;
      number: string | null;
      attendeeId: string | null;
      totals: { totalCents: number };
      amountPaidCents: number;
      balanceCents: number;
    }[];
  }>(owner.token, 'queries', 'invoice.list', { workspaceId: owner.workspaceId });
  expect(invoices).toHaveLength(1);
  expect(invoices[0]).toMatchObject({
    purpose: 'deposit',
    origin: 'booking',
    status: 'paid',
    amountPaidCents: PRICE / 4,
    balanceCents: 0,
  });
  expect(invoices[0]!.totals.totalCents).toBe(PRICE / 4);
  // Linked to the seat it holds, so a deposit and the balance both point at one visit.
  expect(invoices[0]!.attendeeId).toBeTruthy();
  expect(invoices[0]!.number).toContain('INV-');

  const { items } = await api<{ items: { id: string; status: string }[] }>(
    owner.token,
    'queries',
    'appointment.list',
    {
      workspaceId: owner.workspaceId,
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    },
  );
  expect(items.filter((a) => a.status === 'scheduled')).toHaveLength(1);
  const money = await api<{ invoices: { id: string }[] }>(
    owner.token,
    'queries',
    'money.for_record',
    { workspaceId: owner.workspaceId, recordType: 'appointment', recordId: items[0]!.id },
  ).catch(() => null);
  // The panel query is another step's; when it is there, the deposit is what it finds.
  if (money) expect(money.invoices.map((i) => i.id)).toContain(invoices[0]!.id);
  await customer.close();
});

test('the calendar builder saves a deposit of its own and the account it is paid into', async ({
  page,
}) => {
  const owner = await ownerWithSite(page, 'deposit-builder', 'Lone Star Builder HVAC');
  await moneySettings(owner);
  await connectAccount(owner, 'stripe', `acct_b1_${randomUUID().slice(0, 8)}`);
  await connectAccount(owner, 'square', `merchant_b2_${randomUUID().slice(0, 8)}`);
  const serviceId = await pricedService(owner, 'Roof survey');
  const cal = await makeCalendar(owner, 'Roof survey', {
    services: { mode: 'one', items: [{ serviceId }] },
  });

  const builder = `/app/w/${owner.workspaceId}/settings/calendars/${cal.id}`;
  await page.goto(builder);
  await page.getByTestId('module-payments').click();
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();

  // Off by default; a deposit turns the rest of the module on.
  await page.getByTestId('pay-mode-deposit').click();
  const detail = page.getByTestId('pay-module-detail');
  await expect(detail).toContainText('The business asks for 25% of the price');

  // This calendar's own figure, and the account it lands in.
  await detail.getByTestId('deposit-kind').selectOption('percent');
  await detail.getByTestId('deposit-percent').fill('30');
  await detail.getByTestId('pay-account').selectOption({ index: 2 });
  await expect(detail).toContainText('This calendar asks for 30% of the price');
  await expect(page.getByTestId('module-payments')).toContainText('Takes a deposit of 30%');

  // Waited for on purpose: Save is disabled while it is in flight, so "disabled" alone proves nothing.
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().includes('/commands/calendar.save'),
  );
  await page.getByTestId('builder-save').click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId('builder-save')).toBeDisabled();

  // Saved as the calendar's own settings, not the business's.
  const { calendar } = await api<{ calendar: { config: Json } }>(
    owner.token,
    'queries',
    'calendar.get',
    { workspaceId: owner.workspaceId, calendarId: cal.id },
  );
  const payments = (calendar.config as { payments: Json }).payments as {
    mode: string;
    deposit: { kind: string; percentBp: number } | null;
    connectionId: string | null;
  };
  expect(payments.mode).toBe('deposit');
  expect(payments.deposit).toMatchObject({ kind: 'percent', percentBp: 3000 });
  expect(payments.connectionId).toBeTruthy();

  // It sticks: reopened, the module reads back what was saved.
  await page.reload();
  await expect(page.getByTestId('builder-save')).toBeVisible();
  await page.getByTestId('module-payments').click();
  await expect(page.getByTestId('module-panel-payments')).toBeVisible();
  await expect(page.getByTestId('pay-module-detail')).toContainText(
    'This calendar asks for 30% of the price',
  );
  await expect(page.getByTestId('deposit-percent')).toHaveValue('30');
});
