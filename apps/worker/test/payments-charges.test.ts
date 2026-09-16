/**
 * Taking money on the stand-in provider, in both flows: Stripe confirmed in the browser on the stand-in's own
 * payment page, and Square tokenised there and charged from here. A decline is an answer and not an event, a
 * bank transfer sits in `processing` for days, a held card is captured or let go, refunds and disputes land, a
 * plan's cycle bills a saved card, a revoked account refuses mid-charge, and a refund comes back to life when
 * the same account is reconnected.
 *
 * The webhooks the stand-in posts are checked with the **real** adapters' verifiers, signed with the real
 * algorithms — so the code that will read Stripe's and Square's own webhooks is under test here, not just the
 * stand-in's happy path.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  organizationCreate,
  paymentConnectionConnect,
  paymentConnectionDisconnect,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { paymentConnections } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import {
  FAKE_BANK,
  FAKE_CARDS,
  FAKE_SQUARE_SIGNATURE_KEY,
  FAKE_STRIPE_WEBHOOK_SECRET,
  type FakeWebhookPost,
} from '../src/payments/fake';
import { accountByExternalId, accountFor } from '../src/payments/index';
import type { PaymentAccount, PaymentProvider } from '../src/payments/provider';
import { createSquarePayments } from '../src/payments/square';
import { createStripePayments } from '../src/payments/stripe';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { TEST_PUBLIC_URL, testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-payments-charges-${process.pid}`;
const token = () => randomUUID().slice(0, 8);
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const RETURN_URL = 'http://localhost:3000/i/abc123';

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let s: TestServices;
let app: FastifyInstance;
let stripeAccountId: string;
let squareAccountId: string;
let stripe: PaymentAccount;
let square: PaymentAccount;
let squareConnectionId: string;

/** The real adapters, pointed at the stand-in's signing keys: what actually reads a provider's webhooks. */
let realStripe: PaymentProvider;
let realSquare: PaymentProvider;

const scope = () => ({ workspaceId, organizationId });
const get = (url: string) => app.inject({ method: 'GET', url });
const post = (url: string, body: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(body).toString(),
  });

async function drain(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const table of ['outbox', 'webhook_deliveries', 'scheduled_jobs'])
      await rows(
        admin(),
        sql`update ${sql.raw(`app.${table}`)} set locked_at = now(), locked_by = ${WORKER_ID}
            where status = 'pending' and workspace_id = ${workspaceId}`,
      );
    const d = { ...s, workerId: WORKER_ID, batchSize: 200, reservedOnly: true };
    const passes = [
      await processOnce({ ...d, handlers }),
      await processDeliveries({ ...d, processors }),
      await processJobs({ ...d, jobs }),
    ];
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** Signs in through the real routes and returns the connection row's id. */
async function connect(provider: 'stripe' | 'square', account: string): Promise<string> {
  const { output } = await executeCommand(
    api(),
    paymentConnectionConnect,
    { workspaceId, provider, environment: 'test' as const },
    actor(owner),
    meta(),
  );
  const start = await get(`/oauth/${provider}/start?state=${encodeURIComponent(output.state)}`);
  const authorize = new URL(String(start.headers.location));
  const approve = await get(
    `/oauth/fake/payments/${provider}/approve?${new URLSearchParams({
      state: output.state,
      redirect_uri: authorize.searchParams.get('redirect_uri')!,
      account,
      decision: 'allow',
    })}`,
  );
  const callback = new URL(String(approve.headers.location));
  await get(`${callback.pathname}${callback.search}`);
  await drain();
  return output.connectionId;
}

const accountOf = async (connectionId: string): Promise<PaymentAccount> => {
  const [c] = await admin()
    .select()
    .from(paymentConnections)
    .where(eq(paymentConnections.id, connectionId));
  return accountFor(s.sealer, c!);
};

const key = () => `idem-${randomUUID()}`;
const prepareInput = (over: Partial<Parameters<PaymentProvider['prepare']>[1]> = {}) => ({
  amountCents: 12_500,
  methods: ['card'] as const,
  idempotencyKey: key(),
  description: 'Invoice INV-1001',
  customerRef: null,
  hold: false,
  metadata: { invoiceId: 'inv-1' },
  returnUrl: RETURN_URL,
  ...over,
});
const chargeInput = (over: Partial<Parameters<PaymentProvider['charge']>[1]> = {}) => ({
  amountCents: 12_500,
  method: 'card' as const,
  sourceToken: null,
  idempotencyKey: key(),
  description: 'Invoice INV-1001',
  customerRef: null,
  metadata: { invoiceId: 'inv-1' },
  ...over,
});

/** Pays on the stand-in's own page, the way a customer would, and returns where it sent them back to. */
async function payOnPage(
  hostedUrl: string,
  instrument: string,
  method: 'card' | 'ach' = 'card',
): Promise<URL> {
  const page = new URL(hostedUrl);
  const rendered = await get(`${page.pathname}${page.search}`);
  expect(rendered.statusCode).toBe(200);
  expect(rendered.body).toContain(FAKE_CARDS.succeeds);
  const paid = await post('/payments/fake/pay', {
    provider: page.searchParams.get('provider')!,
    account: page.searchParams.get('account')!,
    amount: page.searchParams.get('amount')!,
    ...(page.searchParams.get('intent') ? { intent: page.searchParams.get('intent')! } : {}),
    return: page.searchParams.get('return')!,
    instrument,
    method,
    decision: 'pay',
  });
  expect(paid.statusCode).toBe(302);
  return new URL(String(paid.headers.location));
}

const webhooksFor = (id: string): FakeWebhookPost[] =>
  s.payments.fake.webhooks().filter((p) => p.body.includes(id));

/** Every webhook the stand-in posted is checked by the adapter that will read the real ones. */
function verifiedByTheRealAdapter(p: FakeWebhookPost): boolean {
  const provider = p.provider === 'stripe' ? realStripe : realSquare;
  return provider.webhooks.verify({ rawBody: p.body, headers: p.headers, url: p.url });
}

beforeAll(async () => {
  owner = await createTestUser('payments-charges-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Payments Charges HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  realStripe = createStripePayments({
    clientId: 'ca_test',
    secretKey: 'sk_test_x',
    publishableKey: 'pk_test_x',
    webhookSecret: FAKE_STRIPE_WEBHOOK_SECRET,
  });
  realSquare = createSquarePayments({
    applicationId: 'sandbox-sq0idb-x',
    applicationSecret: 'sq0csp-x',
    webhookSignatureKeys: [FAKE_SQUARE_SIGNATURE_KEY],
    environment: 'test',
  });
  stripeAccountId = `acct_test_${token()}`;
  squareAccountId = `merchant_test_${token()}`;
  stripe = await accountOf(await connect('stripe', stripeAccountId));
  squareConnectionId = await connect('square', squareAccountId);
  square = await accountOf(squareConnectionId);
});
afterAll(async () => {
  // Nothing of this suite's is left waiting for another one to trip over.
  await asWorker(testDbs().worker.db, scope(), (tx) =>
    tx
      .update(paymentConnections)
      .set({ nextRefreshAt: null })
      .where(eq(paymentConnections.workspaceId, workspaceId)),
  );
  await app?.close();
  await closeTestDbs();
});

describe('paying on the stand-in’s page', () => {
  it('Stripe confirms in the browser, and we read the answer back from the provider', async () => {
    const prepared = await s.payments.providers.stripe.prepare(stripe, prepareInput());
    expect(prepared.flow).toBe('client_confirm');
    expect(prepared.clientSecret).toMatch(/_secret$/);
    expect(prepared.providerPaymentId).toMatch(/^pi_/);
    expect(prepared.hostedUrl).toContain('/payments/fake/pay');

    const backTo = await payOnPage(prepared.hostedUrl!, FAKE_CARDS.succeeds);
    expect(backTo.origin + backTo.pathname).toBe(RETURN_URL);
    expect(backTo.searchParams.get('result')).toBe('succeeded');

    // The page said so, but the answer that counts is the provider's own.
    const result = await s.payments.providers.stripe.confirmFromClient(
      stripe,
      prepared.providerPaymentId!,
    );
    expect(result).toMatchObject({
      status: 'succeeded',
      providerStatus: 'succeeded',
      amountCents: 12_500,
      failureCode: null,
    });
    expect(result.feeCents).toBe(Math.round(12_500 * 0.029) + 30);
    expect(result.netCents).toBe(12_500 - result.feeCents!);
    expect(result.receivedAt).not.toBeNull();

    // And Stripe told us, signed the way Stripe signs.
    const told = webhooksFor(prepared.providerPaymentId!);
    expect(told.map((p) => p.type)).toContain('payment_intent.succeeded');
    expect(told.every(verifiedByTheRealAdapter)).toBe(true);
  });

  it('Square tokenises on the page and we charge from here', async () => {
    const prepared = await s.payments.providers.square.prepare(square, prepareInput());
    expect(prepared.flow).toBe('server_charge');
    expect(prepared.clientSecret).toBeNull();
    expect(prepared.providerPaymentId).toBeNull();
    expect(prepared.locationId).toBe(`fake-location-${squareAccountId}`);

    const backTo = await payOnPage(prepared.hostedUrl!, FAKE_CARDS.succeeds);
    const sourceToken = backTo.searchParams.get('token');
    expect(sourceToken).toMatch(/^cnon:/);

    const result = await s.payments.providers.square.charge(square, chargeInput({ sourceToken }));
    expect(result).toMatchObject({ status: 'succeeded', providerStatus: 'COMPLETED' });
    const told = webhooksFor(result.providerPaymentId);
    expect(told.map((p) => p.type)).toContain('payment.updated');
    expect(told.every(verifiedByTheRealAdapter)).toBe(true);
  });

  it('cancelling on the page charges nothing', async () => {
    const prepared = await s.payments.providers.stripe.prepare(stripe, prepareInput());
    const cancelled = await post('/payments/fake/pay', {
      provider: 'stripe',
      account: stripeAccountId,
      amount: '12500',
      intent: prepared.providerPaymentId!,
      return: RETURN_URL,
      decision: 'cancel',
    });
    expect(cancelled.statusCode).toBe(302);
    expect(String(cancelled.headers.location)).toContain('payment=cancelled');
    const still = await s.payments.providers.stripe.confirmFromClient(
      stripe,
      prepared.providerPaymentId!,
    );
    expect(still.status).toBe('requires_payment');
  });

  it('refuses to send the customer anywhere but back to us', async () => {
    // Whatever the link says, the page only ever redirects back to this server or the app.
    const tried = await post('/payments/fake/pay', {
      provider: 'stripe',
      account: stripeAccountId,
      amount: '12500',
      return: 'https://evil.test/steal',
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
      decision: 'pay',
    });
    expect(tried.statusCode).toBe(200);
    expect(String(tried.headers.location ?? '')).not.toContain('evil.test');
  });
});

describe('a decline is an answer, not an event', () => {
  it('Stripe’s comes back from the confirm with plain words and no webhook', async () => {
    const prepared = await s.payments.providers.stripe.prepare(stripe, prepareInput());
    const backTo = await payOnPage(prepared.hostedUrl!, FAKE_CARDS.declines);
    expect(backTo.searchParams.get('result')).toBe('failed');
    const result = await s.payments.providers.stripe.confirmFromClient(
      stripe,
      prepared.providerPaymentId!,
    );
    expect(result).toMatchObject({ status: 'failed', failureCode: 'card_declined' });
    expect(result.failureMessage).toBe(
      'That card was declined. Try another card, or ask your bank why.',
    );
    // Square has no "payment failed" event at all, so nothing here waits for one either.
    expect(webhooksFor(prepared.providerPaymentId!)).toHaveLength(0);
  });

  it('Square’s comes back from the charge', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.declines,
      method: 'card',
    });
    const result = await s.payments.providers.square.charge(square, chargeInput({ sourceToken }));
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('card_declined');
    expect(webhooksFor(result.providerPaymentId)).toHaveLength(0);
  });
});

describe('holds, captures and refunds', () => {
  it('holds a card, captures it, and never says succeeded in between', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
    });
    const held = await s.payments.providers.stripe.authorize(
      stripe,
      chargeInput({ sourceToken, amountCents: 5_000 }),
    );
    expect(held).toMatchObject({
      status: 'processing',
      providerStatus: 'requires_capture',
      capturable: true,
      receivedAt: null,
    });
    const taken = await s.payments.providers.stripe.capture(stripe, {
      providerPaymentId: held.providerPaymentId,
      amountCents: 5_000,
      idempotencyKey: key(),
    });
    expect(taken).toMatchObject({ status: 'succeeded', capturable: false });
    expect(taken.receivedAt).not.toBeNull();
  });

  it('lets a hold go when the slot is gone, and charges nothing', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
    });
    const held = await s.payments.providers.square.authorize(
      square,
      chargeInput({ sourceToken, amountCents: 5_000 }),
    );
    expect(held).toMatchObject({ status: 'processing', providerStatus: 'APPROVED' });
    const released = await s.payments.providers.square.voidAuthorization(square, {
      providerPaymentId: held.providerPaymentId,
      idempotencyKey: key(),
    });
    expect(released).toMatchObject({
      status: 'failed',
      providerStatus: 'CANCELED',
      // Nothing went wrong: it was let go on purpose, so nothing tells the customer their card failed.
      failureCode: null,
      failureMessage: null,
    });
  });

  it('refunds part of a payment, and refuses more than is left', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
    });
    const paid = await s.payments.providers.square.charge(
      square,
      chargeInput({ sourceToken, amountCents: 10_000 }),
    );
    expect(paid.status).toBe('succeeded');
    const refund = await s.payments.providers.square.refund(square, {
      providerPaymentId: paid.providerPaymentId,
      amountCents: 4_000,
      reason: 'Part of the job was cancelled',
      idempotencyKey: key(),
    });
    expect(refund).toMatchObject({ status: 'succeeded', amountCents: 4_000 });
    expect(
      s.payments.fake
        .webhooks()
        .some((p) => p.type === 'refund.updated' && p.body.includes(refund.providerRefundId)),
    ).toBe(true);
    await expect(
      s.payments.providers.square.refund(square, {
        providerPaymentId: paid.providerPaymentId,
        amountCents: 7_000,
        reason: null,
        idempotencyKey: key(),
      }),
    ).rejects.toThrow(/more than is left/);
  });

  it('the same idempotency key charges once', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
    });
    const idempotencyKey = key();
    const first = await s.payments.providers.square.charge(
      square,
      chargeInput({ sourceToken, idempotencyKey, amountCents: 2_500 }),
    );
    const again = await s.payments.providers.square.charge(
      square,
      chargeInput({ sourceToken, idempotencyKey, amountCents: 2_500 }),
    );
    expect(again.providerPaymentId).toBe(first.providerPaymentId);
    expect(
      s.payments.fake.charges().filter((c) => c.idempotencyKey === idempotencyKey),
    ).toHaveLength(1);
  });
});

describe('a bank transfer takes days', () => {
  it('reads as paying, not as failed, and settles later with a signed event', async () => {
    const prepared = await s.payments.providers.square.prepare(
      square,
      prepareInput({ methods: ['ach', 'card'] as const, amountCents: 40_000 }),
    );
    const backTo = await payOnPage(prepared.hostedUrl!, FAKE_BANK.settles, 'ach');
    const sourceToken = backTo.searchParams.get('token')!;
    const started = await s.payments.providers.square.charge(
      square,
      chargeInput({ sourceToken, method: 'ach', amountCents: 40_000 }),
    );
    expect(started).toMatchObject({
      status: 'processing',
      providerStatus: 'PENDING',
      receivedAt: null,
      failureCode: null,
    });

    // Days later, the money lands.
    const settled = await s.payments.fake.settle(started.providerPaymentId);
    expect(settled).toMatchObject({ status: 'succeeded', providerStatus: 'COMPLETED' });
    expect(settled!.receivedAt).not.toBeNull();
    // A bank transfer's fee is the cheap one: 0.8%, capped at five dollars.
    expect(settled!.feeCents).toBe(320);
    const told = webhooksFor(started.providerPaymentId);
    expect(told.length).toBeGreaterThanOrEqual(2);
    expect(told.every(verifiedByTheRealAdapter)).toBe(true);
  });

  it('a transfer the bank sends back comes through as failed', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_BANK.fails,
      method: 'ach',
    });
    const started = await s.payments.providers.stripe.charge(
      stripe,
      chargeInput({ sourceToken, method: 'ach', amountCents: 9_900 }),
    );
    expect(started.status).toBe('processing');
    const returned = await s.payments.fake.failTransfer(started.providerPaymentId);
    expect(returned).toMatchObject({ status: 'failed', failureCode: 'bank_transfer_returned' });
    // Unlike a decline, this one only reaches us as an event, and it is signed.
    const told = webhooksFor(started.providerPaymentId);
    expect(told.map((p) => p.type)).toContain('payment_intent.payment_failed');
    expect(told.every(verifiedByTheRealAdapter)).toBe(true);
  });
});

describe('disputes and plans', () => {
  it('a disputed payment tells us, signed', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.disputes,
      method: 'card',
    });
    const paid = await s.payments.providers.stripe.charge(
      stripe,
      chargeInput({ sourceToken, amountCents: 30_000 }),
    );
    expect(paid.status).toBe('succeeded');
    await s.payments.fake.dispute(paid.providerPaymentId, 'fraudulent');
    const told = webhooksFor(paid.providerPaymentId);
    expect(told.map((p) => p.type)).toContain('charge.dispute.created');
    expect(told.every(verifiedByTheRealAdapter)).toBe(true);
    expect(s.payments.fake.charge(paid.providerPaymentId)?.disputed).toBe(true);
  });

  it('a plan bills its cycle, and a card that fails off-session puts it past due', async () => {
    const { customerRef } = await s.payments.providers.stripe.ensureCustomer(stripe, {
      customerRef: null,
      name: 'Maria Lopez',
      email: 'maria@example.test',
      phone: null,
      idempotencyKey: key(),
    });
    // A card that saves fine and is refused the next time something bills it without her there.
    const saved = await s.payments.providers.stripe.saveMethod(stripe, {
      customerRef,
      sourceToken: s.payments.fake.page.tokenise({
        instrument: FAKE_CARDS.failsOffSession,
        method: 'card',
      }),
      idempotencyKey: key(),
    });
    expect(saved.token).toMatch(/^fakepm:/);
    expect(await s.payments.providers.stripe.listMethods(stripe, customerRef)).toHaveLength(1);

    const plan = await s.payments.providers.stripe.subscriptions.create(stripe, {
      customerRef,
      methodToken: saved.token,
      amountCents: 2_900,
      interval: 'month',
      intervalCount: 1,
      name: 'Maintenance plan',
      startAt: null,
      idempotencyKey: key(),
      metadata: {},
    });
    expect(plan.status).toBe('active');

    const cycle = await s.payments.fake.cycle(plan.providerSubscriptionId);
    expect(cycle).toMatchObject({
      status: 'failed',
      failureCode: 'card_declined',
      amountCents: 2_900,
    });
    const after = await s.payments.providers.stripe.subscriptions.get(stripe, {
      providerSubscriptionId: plan.providerSubscriptionId,
    });
    expect(after.status).toBe('past_due');
    expect(s.payments.fake.webhooks().some((p) => p.type === 'invoice.payment_failed')).toBe(true);

    // Pausing and cancelling go through the provider, which is where the plan really lives.
    await s.payments.providers.stripe.subscriptions.resume(stripe, {
      providerSubscriptionId: plan.providerSubscriptionId,
    });
    const paused = await s.payments.providers.stripe.subscriptions.pause(stripe, {
      providerSubscriptionId: plan.providerSubscriptionId,
      resumeAt: null,
    });
    expect(paused.status).toBe('paused');
    const cancelled = await s.payments.providers.stripe.subscriptions.cancel(stripe, {
      providerSubscriptionId: plan.providerSubscriptionId,
      atPeriodEnd: true,
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelAt).not.toBeNull();
  });
});

describe('when an account goes away', () => {
  it('a revoked connection refuses mid-charge instead of pretending', async () => {
    const otherAccount = `acct_test_${token()}`;
    const connectionId = await connect('stripe', otherAccount);
    const account = await accountOf(connectionId);
    await s.payments.fake.revoke(otherAccount);
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
    });
    await expect(
      s.payments.providers.stripe.charge(account, chargeInput({ sourceToken })),
    ).rejects.toMatchObject({ name: 'PaymentAuthError' });
  });

  it('a refund waits for a reconnect, then works again on the same account', async () => {
    const sourceToken = s.payments.fake.page.tokenise({
      instrument: FAKE_CARDS.succeeds,
      method: 'card',
    });
    const paid = await s.payments.providers.square.charge(
      square,
      chargeInput({ sourceToken, amountCents: 8_000 }),
    );
    expect(paid.status).toBe('succeeded');

    // The business disconnects the account. The tokens are destroyed on purpose.
    await executeCommand(
      api(),
      paymentConnectionDisconnect,
      { workspaceId, connectionId: squareConnectionId, acknowledgeSubscriptions: true },
      actor(owner),
      meta(),
    );
    await drain();
    expect(
      await accountByExternalId(
        testDbs().worker.db,
        scope(),
        { provider: 'square', externalAccountId: squareAccountId },
        s.sealer,
      ),
    ).toBeNull();

    // Reconnecting the *same* account brings the credentials back, so an old payment can still be refunded.
    squareConnectionId = await connect('square', squareAccountId);
    const found = await accountByExternalId(
      testDbs().worker.db,
      scope(),
      { provider: 'square', externalAccountId: squareAccountId },
      s.sealer,
    );
    expect(found?.connection.id).toBe(squareConnectionId);
    const refund = await s.payments.providers.square.refund(found!.account, {
      providerPaymentId: paid.providerPaymentId,
      amountCents: 8_000,
      reason: 'Reconnected and refunded',
      idempotencyKey: key(),
    });
    expect(refund.status).toBe('succeeded');
    square = found!.account;
  });
});

describe('the verifier the real webhooks will meet', () => {
  it('takes what the provider signed and refuses everything else', async () => {
    const posts = s.payments.fake.webhooks();
    expect(posts.length).toBeGreaterThan(5);
    expect(posts.every(verifiedByTheRealAdapter)).toBe(true);

    const stripePost = posts.find((p) => p.provider === 'stripe')!;
    const squarePost = posts.find((p) => p.provider === 'square')!;

    // One byte different in the body, and the signature no longer matches.
    expect(
      realStripe.webhooks.verify({
        rawBody: `${stripePost.body} `,
        headers: stripePost.headers,
        url: stripePost.url,
      }),
    ).toBe(false);
    expect(
      realSquare.webhooks.verify({
        rawBody: `${squarePost.body} `,
        headers: squarePost.headers,
        url: squarePost.url,
      }),
    ).toBe(false);

    // Square signs the URL too, so a body replayed at another path is refused.
    expect(
      realSquare.webhooks.verify({
        rawBody: squarePost.body,
        headers: squarePost.headers,
        url: `${TEST_PUBLIC_URL}/webhooks/square/other`,
      }),
    ).toBe(false);

    // Stripe's five-minute window: an old signature is a replay.
    const old = s.payments.fake.signStripe(stripePost.body, Date.now() - 10 * 60_000);
    expect(
      realStripe.webhooks.verify({ rawBody: stripePost.body, headers: old, url: stripePost.url }),
    ).toBe(false);
    expect(
      realStripe.webhooks.verify({ rawBody: stripePost.body, headers: {}, url: stripePost.url }),
    ).toBe(false);

    // And what they carry is what the routes will route on: an id to deduplicate, and the account.
    const parsedStripe = realStripe.webhooks.parse(stripePost.body)!;
    expect(parsedStripe.id).toBe(stripePost.eventId);
    expect(parsedStripe.accountRef).toBe(stripeAccountId);
    const parsedSquare = realSquare.webhooks.parse(squarePost.body)!;
    expect(parsedSquare.id).toBe(squarePost.eventId);
    expect(parsedSquare.accountRef).toBe(squareAccountId);
    expect(realSquare.webhooks.parse('not json')).toBeNull();
  });

  it('every account’s payments are kept, so a spec can say what was taken', async () => {
    const mine = s.payments.fake
      .charges()
      .filter((c) => c.accountId === stripeAccountId || c.accountId === squareAccountId);
    expect(mine.length).toBeGreaterThan(5);
    expect(mine.filter((c) => c.status === 'succeeded').length).toBeGreaterThan(2);
    expect(mine.some((c) => c.status === 'failed')).toBe(true);
    expect(s.payments.fake.refunds().length).toBeGreaterThanOrEqual(2);
    // Nothing that looks like a card number is kept: only the last four, as a provider would.
    expect(mine.every((c) => c.instrument.length <= 4)).toBe(true);
  });
});
