/**
 * The two payment providers' webhooks: `/webhooks/stripe` and `/webhooks/square`.
 *
 * Everything that arrives here is signed by the stand-in with the **real** algorithms and checked by the real
 * adapters' verifiers, so what is under test is the code that will read Stripe's and Square's own events. A
 * body changed by one character, a signature made for another address, and a timestamp outside the window are
 * all refused before anything is stored; a replay is stored once and handled once; an event about an account
 * nobody here has connected is a 200 and a drop, because a provider given anything else retries for days.
 *
 * And the one that matters most for money: a refund after the business disconnects. The button says "reconnect
 * the account" instead of failing at the provider, and reconnecting the **same** account brings back the
 * ability to refund a payment taken through it long before.
 */
import { randomUUID } from 'node:crypto';
import {
  paymentConnectionDisconnect,
  paymentRefund,
  subscriptionRecordCycle,
  subscriptionStart,
  executeCommand,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, testDbs } from '@hfos/db/testing';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHttpServer } from '../src/http/server';
import { disputeFactsOf } from '../src/money/webhook-events';
import { FAKE_BANK, FAKE_CARDS } from '../src/payments/fake';
import { createStripePayments } from '../src/payments/stripe';
import { systemActor } from '../src/services';
import { testTokenVerifier } from './finish-sign-in';
import { TEST_PUBLIC_URL } from './helpers';
import {
  admin,
  connect,
  deliveryRows,
  drain,
  invoiceRow,
  moneyWorld,
  paymentRows,
  payOnStandInPage,
  post,
  run,
  sentInvoice,
  type MoneyWorld,
  type SentDocument,
} from './money-world';

let w: MoneyWorld;

beforeAll(async () => {
  w = await moneyWorld('money-hooks');
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

const sys = <T>(cmd: Parameters<typeof executeCommand>[1], input: unknown): Promise<T> =>
  executeCommand(
    testDbs().worker.db,
    cmd,
    input,
    systemActor({ workspaceId: w.workspaceId, organizationId: w.organizationId }),
    { correlationId: randomUUID(), channel: 'worker' },
  ).then((r) => r.output as T);

const hook = (provider: 'stripe' | 'square', body: string, headers: Record<string, string>) =>
  w.app.inject({
    method: 'POST',
    url: `/webhooks/${provider}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload: body,
  });

const stripeBody = (
  type: string,
  account: string,
  data: Record<string, unknown>,
  id = `evt_${randomUUID().slice(0, 8)}`,
) =>
  JSON.stringify({
    id,
    object: 'event',
    type,
    account,
    created: Math.floor(Date.now() / 1000),
    data: { object: data },
  });

const squareBody = (
  type: string,
  merchant: string,
  data: Record<string, unknown>,
  id = randomUUID(),
) =>
  JSON.stringify({
    event_id: id,
    merchant_id: merchant,
    type,
    created_at: new Date().toISOString(),
    data: { type: type.split('.')[0], id: String(data['id'] ?? ''), object: data },
  });

const squareUrl = `${TEST_PUBLIC_URL}/webhooks/square`;

/** Pays an invoice by card through Stripe, end to end on the customer's page. */
async function payByCard(
  doc: SentDocument,
  instrument: string = FAKE_CARDS.succeeds,
): Promise<string> {
  const clientId = randomUUID();
  const start = await post(w, `/public/invoice/${doc.token}/pay`, { clientId, method: 'card' });
  expect(start.statusCode, start.body).toBe(200);
  const prepared = start.json() as {
    payment: { hostedUrl: string; providerPaymentId: string };
  };
  await payOnStandInPage(w, prepared.payment.hostedUrl, instrument, 'card');
  const done = await post(w, `/public/invoice/${doc.token}/pay`, {
    clientId,
    providerPaymentId: prepared.payment.providerPaymentId,
  });
  expect(done.statusCode, done.body).toBe(200);
  await drain(w);
  return prepared.payment.providerPaymentId;
}

/** Pays by bank transfer through Square: tokenise on the stand-in's page, then charge from here. */
async function payByBank(doc: SentDocument): Promise<string> {
  const clientId = randomUUID();
  const start = await post(w, `/public/invoice/${doc.token}/pay`, { clientId, method: 'ach' });
  const prepared = start.json() as { payment: { hostedUrl: string } };
  const back = await payOnStandInPage(w, prepared.payment.hostedUrl, FAKE_BANK.settles, 'ach');
  const done = await post(w, `/public/invoice/${doc.token}/pay`, {
    clientId,
    method: 'ach',
    sourceToken: back.searchParams.get('token'),
  });
  expect(done.statusCode, done.body).toBe(200);
  await drain(w);
  const [payment] = await paymentRows(doc.id);
  expect(payment!.status).toBe('processing');
  return payment!.provider_payment_id!;
}

describe('what the routes refuse before anything is stored', () => {
  it('refuses a body changed by one character', async () => {
    const body = stripeBody('payment_intent.succeeded', w.stripe.accountId, {
      id: 'pi_nope',
      object: 'payment_intent',
      amount: 1_000,
      status: 'succeeded',
    });
    const headers = w.s.payments.fake.signStripe(body);
    const tampered = body.replace('"amount":1000', '"amount":100000');
    expect(tampered).not.toBe(body);
    const res = await hook('stripe', tampered, headers);
    expect(res.statusCode).toBe(403);
    // Signed for what was sent: the same bytes go through.
    expect((await hook('stripe', body, headers)).statusCode).toBe(200);
  });

  it('refuses a Square signature made for another address', async () => {
    const body = squareBody('payment.updated', w.square.accountId, {
      id: 'sqpay_nope',
      status: 'COMPLETED',
      amount_money: { amount: 1_000, currency: 'USD' },
    });
    const elsewhere = w.s.payments.fake.signSquare(
      'https://someone-else.test/webhooks/square',
      body,
    );
    expect((await hook('square', body, elsewhere)).statusCode).toBe(403);
    // The address Square really called signs fine.
    const right = w.s.payments.fake.signSquare(squareUrl, body);
    expect((await hook('square', body, right)).statusCode).toBe(200);
  });

  it('refuses a Stripe signature from outside the time window, and one with no signature at all', async () => {
    const body = stripeBody('payment_intent.succeeded', w.stripe.accountId, {
      id: 'pi_old',
      object: 'payment_intent',
      amount: 500,
      status: 'succeeded',
    });
    const stale = w.s.payments.fake.signStripe(body, Date.now() - 20 * 60_000);
    expect((await hook('stripe', body, stale)).statusCode).toBe(403);
    expect((await hook('stripe', body, {})).statusCode).toBe(403);
  });

  it('takes an event for an account nobody here has connected, and drops it', async () => {
    const body = stripeBody('payment_intent.succeeded', 'acct_someone_else', {
      id: 'pi_stranger',
      object: 'payment_intent',
      amount: 2_500,
      status: 'succeeded',
    });
    const res = await hook('stripe', body, w.s.payments.fake.signStripe(body));
    // A 200: anything else and the provider retries it for days.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, ignored: true });
    const stored = await rows(
      admin(),
      sql`select id from app.webhook_deliveries where account_ref = 'acct_someone_else'`,
    );
    expect(stored).toHaveLength(0);
  });

  it('takes an event we don’t act on, and stores nothing', async () => {
    const before = (await deliveryRows(w.workspaceId)).length;
    const body = stripeBody('payment_intent.created', w.stripe.accountId, {
      id: 'pi_new',
      object: 'payment_intent',
      status: 'requires_payment_method',
    });
    const res = await hook('stripe', body, w.s.payments.fake.signStripe(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ignored: true });
    expect(await deliveryRows(w.workspaceId)).toHaveLength(before);
  });

  // Stripe was answered "Invalid signature" for nine days by a worker that had no secret to check with, then
  // turned the endpoint off (2026-10-08). A missing secret is a setting to fix, and is said to be one.
  it('says the signing secret is missing, rather than calling every event a forgery', async () => {
    const said: string[] = [];
    const app = await buildHttpServer({
      ...w.s,
      log: pino({ level: 'warn' }, { write: (line: string) => void said.push(line) }),
      // The real adapter, set up in every way but the secret its webhooks are checked with.
      payments: {
        ...w.s.payments,
        providers: {
          ...w.s.payments.providers,
          stripe: createStripePayments({
            clientId: 'ca_test',
            secretKey: 'sk_test',
            publishableKey: 'pk_test',
            webhookSecret: null,
          }),
        },
      },
      httpDb: testDbs().worker.db,
      verifyToken: testTokenVerifier(),
      webOrigins: ['http://localhost:3000'],
    });
    try {
      const before = (await deliveryRows(w.workspaceId)).length;
      const body = stripeBody('payment_intent.succeeded', w.stripe.accountId, {
        id: 'pi_unchecked',
        object: 'payment_intent',
        amount: 700,
        status: 'succeeded',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        // As Stripe sends it.
        headers: {
          'content-type': 'application/json; charset=utf-8',
          ...w.s.payments.fake.signStripe(body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(403);
      // Stripe shows this on the endpoint's delivery page, curly apostrophes and all.
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toContain('signing secret');
      expect(said.join('\n')).toContain('STRIPE_WEBHOOK_SECRET is not set on the worker');
      expect(await deliveryRows(w.workspaceId)).toHaveLength(before);
    } finally {
      await app.close();
    }
  });
});

describe('what the routes do with an event they take', () => {
  it('stores a replay once and handles it once', async () => {
    const inv = await sentInvoice(w, { connectionId: w.square.connectionId });
    const providerPaymentId = await payByBank(inv);

    // The bank pays days later: the stand-in posts the settlement the way Square would.
    const settled = await post(w, '/test/money/provider-event', {
      workspaceId: w.workspaceId,
      paymentId: providerPaymentId,
      event: 'settle',
    });
    expect(settled.statusCode, settled.body).toBe(200);
    await drain(w);
    expect(await invoiceRow(inv.id)).toMatchObject({ status: 'paid', balance_cents: 0 });

    // Exactly the bytes and headers the provider sent, delivered a second time.
    const posted = w.s.payments.fake
      .webhooks()
      .filter((p) => p.body.includes(providerPaymentId) && p.type === 'payment.updated');
    expect(posted.length).toBeGreaterThan(0);
    const replayed = posted.at(-1)!;
    const again = await hook('square', replayed.body, replayed.headers);
    expect(again.statusCode).toBe(200);
    await drain(w);

    const stored = (await deliveryRows(w.workspaceId)).filter(
      (d) => d.dedupe_key === replayed.eventId,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ signature_valid: true, status: 'done' });
    // One payment, still paid once.
    expect(await paymentRows(inv.id)).toHaveLength(1);
    expect(await invoiceRow(inv.id)).toMatchObject({ status: 'paid', balance_cents: 0 });
  });

  it('records a bank transfer the bank sends back, without un-paying anything else', async () => {
    const inv = await sentInvoice(w, { connectionId: w.square.connectionId });
    const providerPaymentId = await payByBank(inv);
    const returned = await post(w, '/test/money/provider-event', {
      workspaceId: w.workspaceId,
      paymentId: providerPaymentId,
      event: 'fail_transfer',
    });
    expect(returned.statusCode, returned.body).toBe(200);
    await drain(w);
    const [payment] = await paymentRows(inv.id);
    expect(payment!.status).toBe('failed');
    const row = await invoiceRow(inv.id);
    expect(row.status).toBe('sent');
    expect(row.balance_cents).toBe(inv.totalCents);
  });

  it('keeps a dispute where a person can find it', async () => {
    const inv = await sentInvoice(w);
    const providerPaymentId = await payByCard(inv, FAKE_CARDS.disputes);
    const disputed = await post(w, '/test/money/provider-event', {
      workspaceId: w.workspaceId,
      paymentId: providerPaymentId,
      event: 'dispute',
      reason: 'fraudulent',
    });
    expect(disputed.statusCode, disputed.body).toBe(200);
    await drain(w);
    const stored = (await deliveryRows(w.workspaceId)).filter((d) => d.kind === 'payment.disputed');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.at(-1)).toMatchObject({ status: 'done', signature_valid: true });
    // A disputed payment is still a payment that was made: nothing un-pays the invoice.
    expect(await invoiceRow(inv.id)).toMatchObject({ status: 'paid', balance_cents: 0 });
  });

  it('keeps a Square dispute under the names Square uses today, and knows which payment it is', async () => {
    // Square's own shape: the dispute nested under its type, and the payment one level further down.
    const dispute = {
      id: 'sq_dispute_1',
      state: 'WON',
      reason: 'AMOUNT_DIFFERS',
      amount_money: { amount: 8_801, currency: 'USD' },
      disputed_payment: { payment_id: 'sq_payment_disputed' },
    };
    const ids: string[] = [];
    for (const type of ['dispute.state.updated', 'dispute.evidence.created']) {
      const id = randomUUID();
      ids.push(id);
      const body = squareBody(type, w.square.accountId, { dispute }, id);
      const res = await hook('square', body, w.s.payments.fake.signSquare(squareUrl, body));
      expect(res.statusCode, res.body).toBe(200);
    }
    await drain(w);
    const stored = (await deliveryRows(w.workspaceId)).filter((d) => ids.includes(d.dedupe_key));
    expect(stored).toHaveLength(2);
    for (const row of stored)
      expect(row).toMatchObject({
        kind: 'payment.disputed',
        status: 'done',
        signature_valid: true,
      });
    const facts = disputeFactsOf({
      id: ids[0]!,
      type: 'dispute.state.updated',
      accountRef: w.square.accountId,
      createdAt: null,
      data: { dispute },
    });
    expect(facts).toMatchObject({ providerPaymentId: 'sq_payment_disputed', amountCents: 8_801 });
  });

  it('records a plan’s cycle against the plan the provider named', async () => {
    const started = (await run(w, subscriptionStart, {
      workspaceId: w.workspaceId,
      personId: w.person.id,
      planName: 'Comfort Club',
      priceCents: 2_900,
      interval: 'month',
      connectionId: w.stripe.connectionId,
    })) as { subscriptionId: string };
    // The plan really exists at the provider, and our row names it.
    const account = {
      provider: 'stripe' as const,
      externalAccountId: w.stripe.accountId,
      locationId: null,
      accessToken: null,
      environment: 'test' as const,
    };
    const plan = await w.s.payments.fake.providers.stripe.subscriptions.create(account, {
      customerRef: 'cus_test',
      methodToken: null,
      amountCents: 2_900,
      interval: 'month',
      intervalCount: 1,
      name: 'Comfort Club',
      startAt: null,
      idempotencyKey: randomUUID(),
      metadata: {},
    });
    await sys(subscriptionRecordCycle, {
      workspaceId: w.workspaceId,
      subscriptionId: started.subscriptionId,
      outcome: 'activated',
      externalSubscriptionId: plan.providerSubscriptionId,
    });
    await drain(w);

    const billed = await post(w, '/test/money/provider-event', {
      workspaceId: w.workspaceId,
      subscriptionId: plan.providerSubscriptionId,
      event: 'cycle',
    });
    expect(billed.statusCode, billed.body).toBe(200);
    await drain(w);
    const stored = (await deliveryRows(w.workspaceId)).filter((d) => d.kind === 'invoice.paid');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.at(-1)!.status).toBe('done');
    const events = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events
          where workspace_id = ${w.workspaceId} and entity_id = ${started.subscriptionId}::uuid
            and event_type = 'subscription.billed'`,
    );
    expect(events.length).toBeGreaterThan(0);
    const [row] = await rows<{ status: string; failed_cycles: number }>(
      admin(),
      sql`select status::text as status, failed_cycles from app.subscriptions
          where id = ${started.subscriptionId}`,
    );
    expect(row).toMatchObject({ status: 'active', failed_cycles: 0 });
  });

  it('disconnects the account when the seller revokes us at the provider', async () => {
    const account = `acct_${randomUUID().slice(0, 8)}`;
    const extra = await connect(w, 'stripe', account);
    const revoked = await post(w, '/test/money/provider-event', {
      workspaceId: w.workspaceId,
      accountId: account,
      event: 'revoke',
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    await drain(w);
    const [row] = await rows<{ status: string; disconnected_reason: string | null }>(
      admin(),
      sql`select status::text as status, disconnected_reason from app.payment_connections
          where id = ${extra.connectionId}`,
    );
    expect(row).toMatchObject({ status: 'disconnected', disconnected_reason: 'deauthorized' });
  });
});

describe('a refund after a disconnect', () => {
  it('says to reconnect the account, then gives the money back once it is', async () => {
    const inv = await sentInvoice(w, { connectionId: w.square.connectionId });
    const clientId = randomUUID();
    const start = await post(w, `/public/invoice/${inv.token}/pay`, { clientId, method: 'card' });
    const prepared = start.json() as { payment: { hostedUrl: string } };
    const back = await payOnStandInPage(w, prepared.payment.hostedUrl, FAKE_CARDS.succeeds, 'card');
    const paid = await post(w, `/public/invoice/${inv.token}/pay`, {
      clientId,
      method: 'card',
      sourceToken: back.searchParams.get('token'),
    });
    expect(paid.statusCode, paid.body).toBe(200);
    await drain(w);
    const [payment] = await paymentRows(inv.id);
    expect(payment!.status).toBe('succeeded');

    // The business disconnects the account the money was taken into. The tokens are destroyed on purpose.
    await run(w, paymentConnectionDisconnect, {
      workspaceId: w.workspaceId,
      connectionId: w.square.connectionId,
      acknowledgeSubscriptions: true,
    });
    await drain(w);
    await expect(
      run(w, paymentRefund, {
        workspaceId: w.workspaceId,
        paymentId: payment!.id,
        reason: 'Called it off',
      }),
    ).rejects.toMatchObject({ rule: 'payment_connection_not_connected' });

    // The same account, signed in again: credentials resolve by account id, so old payments come back.
    await connect(w, 'square', w.square.accountId);
    const refund = (await run(w, paymentRefund, {
      workspaceId: w.workspaceId,
      paymentId: payment!.id,
      reason: 'Called it off',
    })) as { refundId: string; status: string };
    expect(refund.status).toBe('pending');
    await drain(w);
    const ran = await post(w, '/test/money/run-due', { workspaceId: w.workspaceId });
    expect(ran.statusCode, ran.body).toBe(200);
    await drain(w);

    const [row] = await rows<{ status: string; provider_refund_id: string | null }>(
      admin(),
      sql`select status::text as status, provider_refund_id from app.refunds
          where id = ${refund.refundId}`,
    );
    expect(row).toMatchObject({ status: 'succeeded' });
    expect(row!.provider_refund_id).toBeTruthy();
    const invoice = await invoiceRow(inv.id);
    expect(invoice.amount_refunded_cents).toBe(inv.totalCents);
    // Given back, not owed again: the invoice stays paid with nothing due.
    expect(invoice).toMatchObject({ status: 'paid', balance_cents: 0 });
  });
});
