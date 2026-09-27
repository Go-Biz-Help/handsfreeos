import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { api, finishSignIn, ownerWithSite, WORKER, type Owner } from './booking-helpers';

/**
 * Maintenance plans, end to end (design/m9 Plans.dc.html): a customer put on a plan from the catalogue, the
 * provider set up, a cycle billed and kept here as an invoice and a payment — then given back, when it reads as
 * refunded rather than paid — paused, started again, cancelled, and the Settings → Payments disconnect that
 * lists the plan still billing and offers to cancel it first. The plan's own link copies whether it is waiting
 * on a card or already billing.
 *
 * Everything the provider does runs against the stand-in (apps/worker/src/payments/fake.ts): the cycle is
 * driven on purpose through `POST /test/money/provider-event`, which makes it post its **properly signed**
 * webhook at us, and `POST /test/money/run-due` moves the money jobs up so nothing here waits on real time.
 */

/** The stand-in's numbers (apps/worker/src/payments/fake.ts). */
const CARD_OK = '4242424242424242';
const CARD_DECLINED = '4000000000000002';

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

interface Plan {
  id: string;
  status: string;
  planName: string;
  externalSubscriptionId: string | null;
  nextBillingOn: string | null;
}

const planOf = async (owner: Owner, subscriptionId: string) =>
  await api<{ subscription: Plan; invoices: { id: string; status: string; state: string }[] }>(
    owner.token,
    'queries',
    'subscription.get',
    { workspaceId: owner.workspaceId, subscriptionId },
  );

/**
 * Signs a stand-in payment account in without going near Settings → Payments: the one-time state from the
 * command, the worker's own start route, then the stand-in's approve route. (money-public.spec.ts does the
 * same; each spec keeps its own copy so neither waits on the other's page.)
 */
async function connectAccount(owner: Owner, accountId: string): Promise<string> {
  const { state } = await api<{ connectionId: string; state: string }>(
    owner.token,
    'commands',
    'payment_connection.connect',
    { workspaceId: owner.workspaceId, provider: 'stripe', environment: 'test' },
  );
  const start = await fetch(`${WORKER}/oauth/stripe/start?state=${encodeURIComponent(state)}`, {
    redirect: 'manual',
  });
  const authorize = start.headers.get('location');
  if (!authorize) throw new Error(`no provider sign-in to follow (${start.status})`);
  const approve = new URL(authorize.replace('/authorize', '/approve'));
  approve.searchParams.set('account', accountId);
  approve.searchParams.set('decision', 'allow');
  const approved = await fetch(approve, { redirect: 'manual' });
  const callback = approved.headers.get('location');
  if (!callback) throw new Error(`the stand-in refused the sign-in (${approved.status})`);
  await finishSignIn(owner.token, callback);
  await expect
    .poll(async () => (await accounts(owner)).find((c) => c.status === 'active')?.status)
    .toBe('active');
  return (await accounts(owner)).find((c) => c.status === 'active')!.id;
}

const accounts = async (owner: Owner) =>
  (
    await api<{ connections: { id: string; status: string; provider: string }[] }>(
      owner.token,
      'queries',
      'payment_connection.list',
      { workspaceId: owner.workspaceId, includeDisconnected: true },
    )
  ).connections;

/** A customer on the books, by first name. */
async function customer(owner: Owner, firstName: string, lastName: string): Promise<string> {
  const { personId } = await api<{ personId: string }>(owner.token, 'commands', 'person.create', {
    workspaceId: owner.workspaceId,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@example.test`,
  });
  return personId;
}

/** The customer's own link for a plan, as the message would send it. */
const planLink = async (owner: Owner, subscriptionId: string) =>
  (
    await worker<{ url: string }>('/test/money/link', {
      workspaceId: owner.workspaceId,
      subscriptionId,
    })
  ).url;

/**
 * The customer's side, signed out: open the link, add a card through the stand-in provider's own page, and come
 * back. `card` is the number typed into it — the stand-in declines 4000000000000002 exactly as a real provider
 * refuses a bad card when it is saved.
 */
async function addCardAsCustomer(page: Page, url: string, card: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('plan-page')).toBeVisible();
  await page.getByTestId('plan-add-card').click();
  await page.waitForURL(/\/payments\/fake\/pay/);
  await page.locator('#instrument').fill(card);
  await page.getByTestId('fake-pay').click();
  await page.waitForURL(/\/p\//);
}

/** Waits for the worker to set the plan up at the provider (the event arms a job; run-due hurries it). */
async function waitForProvider(owner: Owner, subscriptionId: string): Promise<string> {
  await expect
    .poll(
      async () => {
        await worker('/test/money/run-due', { workspaceId: owner.workspaceId });
        const got = await planOf(owner, subscriptionId);
        return got.subscription.externalSubscriptionId;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .not.toBeNull();
  return (await planOf(owner, subscriptionId)).subscription.externalSubscriptionId!;
}

const planUrl = (owner: Owner, id: string) => `/app/w/${owner.workspaceId}/money/plans/${id}`;

/** Puts someone on the business's only plan from the Plans page, and lands on the plan's own page. */
async function startPlanFromTheList(page: Page, owner: Owner, plan: string, who: string) {
  await page.goto(`/app/w/${owner.workspaceId}/money/plans`);
  await expect(page.getByTestId('plans-table')).toContainText(plan);
  await page.getByTestId('plan-start').click();
  await expect(page.getByTestId('start-plan-dialog')).toBeVisible();
  await page.getByTestId('money-person-picker').fill(who);
  await page.getByTestId(`money-person-${who}`).click();
  // One plan in the catalogue, so the dialog already has it; the account is the only connected one.
  await expect(page.getByTestId('plan-choice')).toContainText(plan);
  await expect(page.getByTestId('plan-summary')).toContainText('$');
  await page.getByTestId('plan-start-confirm').click();
  await page.waitForURL(/\/money\/plans\/[0-9a-f-]{36}$/);
  return page.url().split('/').pop()!;
}

async function moneyOwner(page: Page, label: string): Promise<Owner & { accountId: string }> {
  const owner = await ownerWithSite(page, label, 'Lone Star Plans HVAC');
  await api(owner.token, 'commands', 'money.save_settings', {
    workspaceId: owner.workspaceId,
    settings: {
      tax: { rateBp: 0, name: 'No tax' },
      numbering: {
        estimate: { prefix: 'EST-', next: 1001 },
        invoice: { prefix: 'INV-', next: 1001 },
      },
    },
  });
  // Tests run at any hour: nothing here should wait on quiet hours.
  await api(owner.token, 'commands', 'phone.update_settings', {
    workspaceId: owner.workspaceId,
    quietHours: { enabled: false, start: '20:00', end: '08:00' },
  });
  // A live account belongs to one business at a time, so each run signs in with its own.
  const accountId = await connectAccount(owner, `acct_${label}_${randomUUID().slice(0, 8)}`);
  return { ...owner, accountId };
}

test('Money → Plans: a plan started, billed, paused, started again and cancelled', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  // Copy link writes to the clipboard, and the spec reads it back.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const owner = await moneyOwner(page, 'plans');
  await api(owner.token, 'commands', 'plan.create', {
    workspaceId: owner.workspaceId,
    name: 'Comfort Club',
    priceCents: 2_900,
    interval: 'month',
    includes: ['Two visits a year', '15% off repairs'],
  });
  await customer(owner, 'Sarah', 'Alvarez');

  // ---- the catalogue, and putting someone on a plan ----
  const subscriptionId = await startPlanFromTheList(page, owner, 'Comfort Club', 'Sarah Alvarez');
  // A draft until the provider has it — which the worker may already have done by the time this loads.
  await expect(page.getByTestId('plan-status')).toHaveText(/Draft|Billing/);
  await expect(page.getByTestId('plan-engine')).toContainText('Stripe Billing');
  // The two things the provider decides, said on the page rather than found out later.
  await expect(page.getByTestId('plan-schedule')).toContainText(
    'The card never touches HandsFreeOS',
  );
  await expect(page.getByTestId('plan-cycles')).toContainText(
    'Pausing stops the charges and keeps Sarah on the plan',
  );

  // ---- it waits on the customer, because nobody will bill a card they do not have ----
  await expect(page.getByTestId('plan-status')).toHaveText('Draft');
  await expect(page.getByTestId('plan-awaiting-card')).toContainText(
    'Waiting on Sarah Alvarez to add a card',
  );
  await expect(page.getByTestId('plan-standing')).toContainText('Nothing is billed until they do');
  await expect(page.getByTestId('plan-card')).toContainText('None yet');
  // The business asks, and the link goes out on the same ladder every other money message uses.
  await page.getByTestId('plan-ask-email').click();
  await expect(page.getByTestId('plan-awaiting-card')).toBeVisible();
  // Or it copies that same link, to send however else it talks to Sarah.
  await page.getByTestId('plan-copy-link').click();
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Link copied' })
      .filter({ hasText: 'Anyone with this link can put a card on this plan.' }),
  ).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^http:\/\/localhost:3000\/p\/[0-9A-Za-z]{18}$/);
  expect(link).toBe(await planLink(owner, subscriptionId));

  // ---- the customer, signed out, opens the copied link and puts a card on it through the provider's page ----
  const customerPage = await page.context().browser()!.newContext();
  const theirs = await customerPage.newPage();
  await theirs.goto(link);
  await expect(theirs.getByTestId('plan-hero')).toContainText('Comfort Club');
  await expect(theirs.getByTestId('plan-hero')).toContainText('Your plan is ready to start');
  await expect(theirs.getByTestId('plan-first-charge')).toContainText('As soon as you add a card');
  await expect(theirs.getByTestId('plan-card-note')).toContainText('never held by');

  // A card the provider refuses is an answer, not a failure state: the plan stays exactly where it was.
  await addCardAsCustomer(theirs, link, CARD_DECLINED);
  await expect(theirs.getByTestId('plan-declined')).toContainText('still waiting');
  await expect(theirs.getByTestId('plan-card-on-file')).toHaveText('None yet');
  expect((await planOf(owner, subscriptionId)).subscription.status).toBe('draft');

  // And one it takes starts the plan.
  await addCardAsCustomer(theirs, link, CARD_OK);
  await expect(theirs.getByTestId('plan-saved')).toContainText('Your card is on your Comfort Club');
  await expect(theirs.getByTestId('plan-card-on-file')).toContainText('•••• 4242');
  await customerPage.close();

  // ---- the worker sets it up at the provider, now that there is a card to bill ----
  const providerPlanId = await waitForProvider(owner, subscriptionId);
  await page.reload();
  await expect(page.getByTestId('plan-status')).toHaveText('Billing');
  await expect(page.getByTestId('plan-engine')).toContainText(providerPlanId);
  await expect(page.getByTestId('plan-standing')).toContainText('Next charge');
  await expect(page.getByTestId('plan-awaiting-card')).toHaveCount(0);
  await expect(page.getByTestId('plan-card')).toContainText('•••• 4242');
  // Billing, the same page is where the card is changed later, so its link copies from beside the ask.
  await expect(page.getByTestId('plan-change-card')).toBeVisible();
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.getByTestId('plan-copy-link').click();
  await expect(
    page
      .locator('[data-sonner-toast]')
      .filter({ hasText: 'Link copied' })
      .filter({ hasText: 'Anyone with this link can put a card on this plan.' }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  // ---- a cycle: the provider bills it, and it lands here as an invoice and a payment ----
  await worker('/test/money/provider-event', {
    workspaceId: owner.workspaceId,
    event: 'cycle',
    subscriptionId: providerPlanId,
  });
  await expect
    .poll(
      async () => {
        await worker('/test/money/run-due', { workspaceId: owner.workspaceId });
        return (await planOf(owner, subscriptionId)).invoices.length;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBeGreaterThan(0);
  await page.reload();
  const cycles = page.getByTestId('plan-cycles');
  await expect(cycles).toContainText('INV-1001');
  await expect(cycles).toContainText('$29');
  await expect(cycles).toContainText('Paid');

  // The money is on the ledger like any other dollar the business takes.
  const payments = await api<{ payments: { id: string; amountCents: number; method: string }[] }>(
    owner.token,
    'queries',
    'payment.list',
    { workspaceId: owner.workspaceId, succeededOnly: true },
  );
  expect(payments.payments[0]).toMatchObject({ amountCents: 2_900, method: 'card' });

  // ---- given back: the cycle reads as refunded on the plan, never as paid ----
  await api(owner.token, 'commands', 'payment.refund', {
    workspaceId: owner.workspaceId,
    paymentId: payments.payments[0]!.id,
    reason: 'The visit was missed',
  });
  await expect
    .poll(
      async () => {
        await worker('/test/money/run-due', { workspaceId: owner.workspaceId });
        return (await planOf(owner, subscriptionId)).invoices[0]?.state;
      },
      { timeout: 60_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe('refunded');
  await page.reload();
  await expect(cycles.getByTestId('plan-cycle-status')).toHaveText('Refunded');
  await expect(cycles).toContainText('1 invoice · 0 paid · 1 refunded');

  // ---- paused, then started again ----
  await page.getByTestId('plan-pause').click();
  await expect(page.getByTestId('plan-status')).toHaveText('Paused');
  await expect(page.getByTestId('plan-standing')).toContainText('Nothing is being charged');
  await page.getByTestId('plan-resume').click();
  await expect(page.getByTestId('plan-status')).toHaveText('Billing');

  // ---- cancelled, with what it means said before the button is pressed ----
  await page.getByTestId('plan-cancel').click();
  await expect(page.getByTestId('plan-cancel-dialog')).toContainText(
    'Sarah Alvarez keeps the visits they have already paid for',
  );
  await page.getByTestId('plan-cancel-confirm').click();
  await expect(page.getByTestId('plan-status')).toHaveText('Cancelled');
  await expect(page.getByTestId('plan-cycles')).toContainText('This plan has ended');
  // What it billed stays.
  await expect(page.getByTestId('plan-cycles')).toContainText('INV-1001');
});

test('Money → Plans: Square says what it will not do, and disconnecting asks about the plan first', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const owner = await moneyOwner(page, 'plans-off');
  await api(owner.token, 'commands', 'plan.create', {
    workspaceId: owner.workspaceId,
    name: 'Commercial Care',
    priceCents: 14_900,
    interval: 'month',
  });
  await customer(owner, 'Riverside', 'Apartments');
  const subscriptionId = await startPlanFromTheList(
    page,
    owner,
    'Commercial Care',
    'Riverside Apartments',
  );
  const link = await planLink(owner, subscriptionId);
  const customerPage = await page.context().browser()!.newContext();
  const theirs = await customerPage.newPage();
  await addCardAsCustomer(theirs, link, CARD_OK);
  await expect(theirs.getByTestId('plan-saved')).toBeVisible();
  await customerPage.close();
  await waitForProvider(owner, subscriptionId);

  // ---- Settings → Payments: the disconnect lists the plan, and offers to cancel it first ----
  await page.goto(`/app/w/${owner.workspaceId}/settings/payments`);
  const card = page.getByTestId(`pay-account-${owner.accountId}`);
  await expect(card).toContainText('1 plan bills through it.');
  await page.getByRole('button', { name: /actions$/ }).click();
  await page.getByRole('menuitem', { name: 'Disconnect' }).click();
  const listed = page.getByTestId('pay-disconnect-plans');
  await expect(listed).toContainText('Commercial Care');
  await expect(page.getByText(/Cancel them first/)).toBeVisible();

  // Cancelling them first is the way out that leaves nobody being charged by a provider we cannot reach.
  await page.getByTestId('pay-cancel-plans').click();
  await expect(page.getByTestId(`pay-account-${owner.accountId}`)).toHaveCount(0);
  const gone = (await accounts(owner)).find((c) => c.id === owner.accountId)!;
  expect(gone.status).toBe('disconnected');
  const plan = await planOf(owner, subscriptionId);
  expect(plan.subscription.status).toBe('cancelled');

  // And the plan's own page says the plan ended rather than quietly leaving it billing somewhere.
  await page.goto(planUrl(owner, subscriptionId));
  await expect(page.getByTestId('plan-status')).toHaveText('Cancelled');
});

test('Money → Plans: a plan made, changed and no longer sold, all from the page', async ({
  page,
}) => {
  // The catalogue once had no screen at all: the empty page pointed at Settings → Products, which pointed back.
  const owner = await ownerWithSite(page, 'plans-new', 'Lone Star Catalogue HVAC');
  await page.goto(`/app/w/${owner.workspaceId}/money/plans`);
  await expect(page.getByText('Press New plan to add the first one.')).toBeVisible();

  await page.getByTestId('plan-new').click();
  await page.getByTestId('plan-editor-name').fill('Comfort Club');
  await page.getByTestId('plan-editor-price').fill('29');
  await page.getByTestId('plan-editor-includes').fill('Two tune-ups a year\n15% off repairs');
  await page.getByTestId('plan-editor-save').click();
  await expect(page.getByTestId('plans-table')).toContainText('Comfort Club');
  await expect(page.getByTestId('plans-table')).toContainText('$29 a month');
  await expect(page.getByTestId('plans-table')).toContainText(
    'Two tune-ups a year, 15% off repairs',
  );

  await page.getByTestId('plan-edit-Comfort Club').click();
  await page.getByTestId('plan-editor-price').fill('290');
  await page.getByTestId('plan-editor-every').selectOption({ label: 'Every year' });
  await page.getByTestId('plan-editor-save').click();
  await expect(page.getByTestId('plans-table')).toContainText('$290 a year');

  await page.getByTestId('plan-edit-Comfort Club').click();
  await page.getByTestId('plan-editor-archive').click();
  await expect(page.getByTestId('plans-table')).toBeHidden();
  await expect(page.getByText('No plans yet')).toBeVisible();
});
