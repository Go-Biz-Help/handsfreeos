import { expect, test, type Page } from '@playwright/test';
import { api, makeCalendar, ownerWithSite, type Owner } from './booking-helpers';

/**
 * Settings → Payments and Products (design/m9 Settings.dc.html and Products.dc.html), plus the calendar's
 * Payments module now that it has something to be paid into.
 *
 * Connecting goes the whole way round: `payment_connection.connect` for a one-time state, the worker's
 * `/oauth/<provider>/start`, the stand-in provider's sign-in page, and back here with `?payments=`. Nothing
 * secret is ever on screen, so everything is checked against the saved settings and the connection list.
 */

interface MoneySettings {
  businessAddress: string;
  tax: { rateBp: number; name: string; newProductsTaxable: boolean };
  numbering: {
    estimate: { prefix: string; next: number; pad: number };
    invoice: { prefix: string; next: number; pad: number };
  };
  terms: string;
  notes: { estimate: string; invoice: string };
  estimateGoodForDays: number;
  deposit: { kind: string; percentBp: number; amountCents: number };
  bankTransfer: boolean;
  reminders: {
    beforeDueDays: number[];
    onDue: boolean;
    afterDueDays: number[];
    estimateAfterDays: number | null;
  };
}

interface Connection {
  id: string;
  provider: string;
  status: string;
  isDefault: boolean;
  externalAccountId: string | null;
  displayName: string | null;
}

/** The money settings as they are actually stored, with every default filled in. */
const savedSettings = async (owner: Owner): Promise<MoneySettings> =>
  (
    await api<{ settings: MoneySettings }>(owner.token, 'queries', 'money.settings', {
      workspaceId: owner.workspaceId,
    })
  ).settings;

const savedAccounts = async (owner: Owner): Promise<Connection[]> =>
  (
    await api<{ connections: Connection[] }>(owner.token, 'queries', 'payment_connection.list', {
      workspaceId: owner.workspaceId,
      includeDisconnected: true,
    })
  ).connections;

/** Types into a box and leaves it, which is what saves it. */
async function enter(page: Page, testId: string, value: string) {
  const box = page.getByTestId(testId);
  await box.fill(value);
  await box.press('Enter');
}

/**
 * The whole sign-in, through the stand-in provider's own page: Connect, the account id the seller signs in
 * with, then back to Settings → Payments.
 */
async function connectAccount(page: Page, provider: 'stripe' | 'square', accountId: string) {
  await page.getByTestId(`connect-${provider}`).click();
  await page.waitForURL(new RegExp(`/oauth/fake/payments/${provider}/authorize`));
  await page.locator('#account').fill(accountId);
  await page.getByTestId('fake-connect').click();
  await page.waitForURL(/\/settings\/payments/);
  await expect(page.getByTestId('payments-settings')).toBeVisible();
}

test('Settings → Payments: two accounts, the default, a disconnect, and every setting read back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'money-settings', 'Lone Star Money HVAC');

  // In the Settings nav, after Website chat and before Action Center.
  await page.goto(`/app/w/${owner.workspaceId}/settings`);
  const nav = page.getByRole('navigation', { name: 'Settings' });
  const tabs = await nav.getByRole('link').allTextContents();
  expect(tabs).toContain('Payments');
  expect(tabs).toContain('Products');
  expect(tabs.indexOf('Payments')).toBeGreaterThan(tabs.indexOf('Website chat'));
  expect(tabs.indexOf('Products')).toBeLessThan(tabs.indexOf('Action Center'));

  await nav.getByRole('link', { name: 'Payments', exact: true }).click();
  await expect(page.getByTestId('pay-no-accounts')).toBeVisible();

  // ---- the accounts money is paid into ----
  await connectAccount(page, 'stripe', 'acct_lonestar_1');
  const afterFirst = (await savedAccounts(owner)).filter((c) => c.status === 'active');
  expect(afterFirst).toHaveLength(1);
  expect(afterFirst[0]!.provider).toBe('stripe');
  // The first account a business connects is where everything is paid into.
  expect(afterFirst[0]!.isDefault).toBe(true);
  const stripeCard = page.getByTestId(`pay-account-${afterFirst[0]!.id}`);
  await expect(stripeCard).toContainText('acct_lonestar_1');
  await expect(stripeCard).toContainText('Connected');
  await expect(page.getByTestId(`pay-default-${afterFirst[0]!.id}`)).toBeVisible();

  // A second one, of the other kind, and it does not steal the default.
  await connectAccount(page, 'square', 'merchant_heights');
  const both = (await savedAccounts(owner)).filter((c) => c.status === 'active');
  expect(both).toHaveLength(2);
  const square = both.find((c) => c.provider === 'square')!;
  const stripe = both.find((c) => c.provider === 'stripe')!;
  expect(square.isDefault).toBe(false);
  await expect(page.getByTestId(`pay-account-${square.id}`)).toContainText(
    'Square signs you out every 30 days',
  );

  await page.getByTestId(`pay-make-default-${square.id}`).click();
  await expect(page.getByTestId(`pay-default-${square.id}`)).toBeVisible();
  const moved = await savedAccounts(owner);
  expect(moved.find((c) => c.id === square.id)!.isDefault).toBe(true);
  expect(moved.find((c) => c.id === stripe.id)!.isDefault).toBe(false);

  // Disconnecting forgets the sign-in. Nothing here bills a plan, so it goes straight through; the page says
  // what would happen if one did.
  await expect(page.getByTestId('pay-accounts')).toContainText(
    'Disconnecting asks about the plans billing through that account first',
  );
  await page.getByRole('button', { name: /Stripe actions|acct_lonestar_1 actions/ }).click();
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  await expect(page.getByTestId(`pay-account-${stripe.id}`)).toHaveCount(0);
  const gone = await savedAccounts(owner);
  expect(gone.find((c) => c.id === stripe.id)!.status).toBe('disconnected');

  // ---- the settings themselves ----
  // Nothing has gone out yet, so nobody is told off about an address that isn't needed until it is.
  await expect(page.getByTestId('pay-address')).toBeVisible();
  await expect(page.getByTestId('issue-no_business_address')).toHaveCount(0);

  await enter(page, 'tax-rate', '8.25');
  await enter(page, 'tax-name', 'TX sales tax');
  await enter(page, 'invoice-prefix', 'INV-');
  await enter(page, 'invoice-next', '1045');
  await expect(page.getByTestId('invoice-preview')).toHaveText('INV-1045');
  await enter(page, 'estimate-prefix', 'EST-');
  await enter(page, 'estimate-next', '1043');
  await expect(page.getByTestId('estimate-preview')).toHaveText('EST-1043');

  await page.getByTestId('terms').selectOption('net_30');
  await enter(page, 'estimate-good-for', '21');

  // Reminders: the last nudge off, and the count underneath keeps up.
  await page.getByTestId('reminder-after-14-switch').click();
  await expect(page.getByTestId('reminder-after-14')).toHaveAttribute('data-on', 'no');
  await expect(page.getByTestId('reminder-count')).toHaveText('4 reminders per invoice.');

  await page.getByTestId('bank-transfer-switch').click();
  await page.getByTestId('deposit-switch').click();
  await enter(page, 'deposit-percent-value', '25');

  await expect
    .poll(async () => {
      const s = await savedSettings(owner);
      return {
        address: s.businessAddress,
        tax: [s.tax.rateBp, s.tax.name],
        invoice: [s.numbering.invoice.prefix, s.numbering.invoice.next],
        estimate: [s.numbering.estimate.prefix, s.numbering.estimate.next],
        terms: s.terms,
        goodFor: s.estimateGoodForDays,
        reminders: [s.reminders.beforeDueDays, s.reminders.onDue, s.reminders.afterDueDays],
        bankTransfer: s.bankTransfer,
        deposit: [s.deposit.kind, s.deposit.percentBp],
      };
    })
    .toEqual({
      address: '',
      tax: [825, 'TX sales tax'],
      invoice: ['INV-', 1045],
      estimate: ['EST-', 1043],
      terms: 'net_30',
      goodFor: 21,
      reminders: [[3], true, [3, 7]],
      bankTransfer: false,
      deposit: ['percent', 2500],
    });

  // ---- two settings that fight, and their fixes ----
  // Due on receipt with a reminder three days before it would send before the invoice does.
  await page.getByTestId('terms').selectOption('due_on_receipt');
  const early = page.getByTestId('issue-reminder_before_sending');
  await expect(early).toContainText('due on receipt');
  await expect(early).toContainText('Doesn’t stop it saving');
  await page.getByTestId('fix-reminder_before_sending-drop_early_reminders').click();
  await expect(early).toHaveCount(0);
  await expect.poll(async () => (await savedSettings(owner)).reminders.beforeDueDays).toEqual([]);

  // A deposit of "a set amount" with no amount in it is an error, and nothing is saved until it is sorted.
  await page.getByTestId('deposit-amount').click();
  const noAmount = page.getByTestId('issue-deposit_without_amount');
  await expect(noAmount).toContainText('an amount of $0');
  await expect(page.getByTestId('money-settings-state')).toHaveAttribute('data-blocked', 'yes');
  expect((await savedSettings(owner)).deposit.kind).toBe('percent');
  await page.getByTestId('fix-deposit_without_amount-deposit_percent').click();
  await expect(noAmount).toHaveCount(0);
  await expect(page.getByTestId('money-settings-state')).toHaveAttribute('data-blocked', 'no');
  await expect
    .poll(async () => (await savedSettings(owner)).deposit)
    .toMatchObject({ kind: 'percent', percentBp: 2500 });

  // ---- the address, once something has actually gone out ----
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName: 'Maria',
    lastName: 'Lopez',
    email: 'maria.lopez@example.test',
  });
  const { estimateId } = await api<{ estimateId: string }>(
    owner.token,
    'commands',
    'estimate.create',
    {
      workspaceId: owner.workspaceId,
      personId,
      title: 'New AC install',
      lines: [{ name: 'Smart thermostat', quantity: 1, unitPriceCents: 28900 }],
    },
  );
  await api(owner.token, 'commands', 'estimate.send', {
    workspaceId: owner.workspaceId,
    estimateId,
    channels: ['email'],
  });

  await page.reload();
  const noAddress = page.getByTestId('issue-no_business_address');
  await expect(noAddress).toContainText('without your address on them');
  await expect(noAddress).toContainText('Doesn’t stop it saving');
  // Nobody can patch in an address, so the fix puts the cursor in the box.
  await page.getByTestId('fix-no_business_address-write_it').click();
  const address = page.getByTestId('business-address');
  await expect(address).toBeFocused();
  await address.fill('Lone Star Money HVAC\n2210 Oak St\nHouston, TX 77008');
  await address.blur();
  await expect(noAddress).toHaveCount(0);
  await expect
    .poll(async () => (await savedSettings(owner)).businessAddress)
    .toBe('Lone Star Money HVAC\n2210 Oak St\nHouston, TX 77008');

  // What the owner is told about the cheap rail, and never told to a customer.
  await expect(page.getByTestId('pay-methods')).toContainText(
    'About 1% of the payment, capped at $5',
  );
  await expect(page.getByTestId('pay-methods')).toContainText(
    'It shows first because it costs you the least',
  );
  await expect(page.getByTestId('pay-methods')).toContainText(
    'Surcharging is banned in four states',
  );
});

test('Settings → Products: an item added, changed, archived and put back', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'money-products', 'Lone Star Catalogue HVAC');
  await api(owner.token, 'commands', 'service.create', {
    workspaceId: owner.workspaceId,
    name: 'AC tune-up',
    durations: [60],
    defaultDuration: 60,
  });

  await page.goto(`/app/w/${owner.workspaceId}/settings/payments/products`);
  await expect(page.getByTestId('products')).toContainText('Nothing to sell yet');

  await page.getByTestId('product-new').click();
  await page.getByTestId('product-name').fill('Smart thermostat');
  await page.getByTestId('product-sku').fill('TSTAT-SM');
  await page.getByTestId('product-price').fill('289');
  await page.getByTestId('product-unit').fill('each');
  await page.getByTestId('product-service').selectOption({ label: 'AC tune-up' });
  await page.getByTestId('product-save').click();

  const row = page.getByTestId('product-row-Smart thermostat');
  await expect(row).toContainText('TSTAT-SM');
  await expect(row).toContainText('$289');
  await expect(row).toContainText('Taxable');
  await expect(row).toContainText('AC tune-up');

  // Repricing it in the catalogue: a line already written keeps what it was sold at, which core owns.
  await row.click();
  await expect(page.getByTestId('product-editor')).toBeVisible();
  await page.getByTestId('product-price').fill('299');
  await page.getByTestId('product-taxable').click();
  await page.getByTestId('product-save').click();
  await expect(row).toContainText('$299');
  await expect(row).toContainText('No tax');

  const list = async () =>
    (
      await api<{
        products: { name: string; unitPriceCents: number; archivedAt: string | null }[];
      }>(owner.token, 'queries', 'product.list', {
        workspaceId: owner.workspaceId,
        includeArchived: true,
      })
    ).products;
  expect((await list())[0]).toMatchObject({ unitPriceCents: 29900, archivedAt: null });

  // Archiving keeps it on the documents it is already on, and takes it out of the picker.
  page.once('dialog', (d) => void d.accept());
  await row.click();
  await page.getByTestId('product-archive').click();
  await expect(page.getByTestId('products')).toContainText('1 archived item');
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await list())[0]!.archivedAt).not.toBeNull();

  await page.getByTestId('show-archived').click();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-archived', 'yes');
  await row.click();
  await page.getByTestId('product-archive').click();
  await expect.poll(async () => (await list())[0]!.archivedAt).toBeNull();
});

test('The calendar’s Payments module: off without an account, on with one', async ({ page }) => {
  test.setTimeout(180_000);
  const owner = await ownerWithSite(page, 'money-deposit-module', 'Lone Star Deposits HVAC');
  const calendar = await makeCalendar(owner, 'Duct cleaning');

  // Nothing is connected yet, so asking for a deposit is a conflict with a way out of it.
  await page.goto(`/app/w/${owner.workspaceId}/settings/calendars/${calendar.id}`);
  await page.getByTestId('module-payments').click();
  await expect(page.getByTestId('module-panel-payments')).toContainText(
    'No payment account is connected yet',
  );
  await page.getByTestId('pay-mode-deposit').click();
  const issue = page.getByTestId('issue-payment_unavailable');
  await expect(issue).toContainText('needs a connected payment account');
  await expect(page.getByTestId('fix-payment_unavailable-connect_account')).toHaveAttribute(
    'href',
    `/app/w/${owner.workspaceId}/settings/payments`,
  );
  await page.getByTestId('fix-payment_unavailable-payment_off').click();
  await expect(issue).toHaveCount(0);

  // Connect one, and the same choice is fine: the module names the deposit and the account behind it.
  await page.goto(`/app/w/${owner.workspaceId}/settings/payments`);
  await connectAccount(page, 'stripe', 'acct_deposits_1');
  await page.getByTestId('deposit-switch').click();
  await enter(page, 'deposit-percent-value', '25');
  await expect.poll(async () => (await savedSettings(owner)).deposit.kind).toBe('percent');

  await page.goto(`/app/w/${owner.workspaceId}/settings/calendars/${calendar.id}`);
  await page.getByTestId('module-payments').click();
  await page.getByTestId('pay-mode-deposit').click();
  await expect(page.getByTestId('issue-payment_unavailable')).toHaveCount(0);
  const detail = page.getByTestId('pay-module-detail');
  await expect(detail).toContainText('25% of the price');
  await expect(detail).toContainText('acct_deposits_1');
  await expect(page.getByTestId('module-payments')).toContainText('Takes a deposit to book');

  await page.getByTestId('builder-save').click();
  await expect(page.getByText(/^Saved as revision \d+\./)).toBeVisible();
  const saved = await api<{ calendar: { config: { payments: { mode: string } } } }>(
    owner.token,
    'queries',
    'calendar.get',
    { workspaceId: owner.workspaceId, calendarId: calendar.id },
  );
  expect(saved.calendar.config.payments.mode).toBe('deposit');
});
