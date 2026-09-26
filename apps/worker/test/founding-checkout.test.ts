/**
 * Paying for a founding seat (0093), end to end on the stand-in provider: somebody presses Pay, the worker makes
 * the Stripe page, the page is paid, Stripe's signed event arrives at our own account's endpoint, and the seat
 * goes active with its plan. And the other ways it goes: the page lapses, an event is forged, an event signed
 * for the Connect endpoint is sent here instead.
 *
 * The first block needs no database: it checks what the real Stripe adapter sends and accepts, over a stubbed
 * fetch — our own money needs only our own key, carries no business's account, and our own events are verified
 * with their own secret.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  executeCommand,
  foundingStartCheckout,
  organizationCreate,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs } from '../src/jobs';
import { processOnce } from '../src/outbox';
import {
  FAKE_STRIPE_PLATFORM_WEBHOOK_SECRET,
  FAKE_STRIPE_WEBHOOK_SECRET,
} from '../src/payments/fake';
import { hmacHex } from '../src/payments/provider';
import { createStripePayments, readStripeCheckoutEvent } from '../src/payments/stripe';
import type { Opinly } from '../src/opinly';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-founding-checkout-${process.pid}`;

// ---------- the Stripe adapter, over a stubbed fetch ----------

function stripeWatching(opts: { clientId?: string | null; platformWebhookSecret?: string | null }) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchStub = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(url),
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: String(init?.body ?? ''),
    });
    return new Response(
      JSON.stringify({
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/c/pay/cs_test_1',
        expires_at: 1_900_000_000,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const provider = createStripePayments({
    clientId: opts.clientId ?? null,
    secretKey: 'sk_test_ours',
    publishableKey: null,
    webhookSecret: 'whsec_connect',
    platformWebhookSecret: opts.platformWebhookSecret ?? null,
    fetch: fetchStub as typeof fetch,
  });
  return { provider, calls };
}

const checkoutInput = {
  checkoutId: '7b0d7e3e-6c61-4f0e-9d0a-3d1f5b0b8a11',
  amountCents: 49_700,
  productName: 'HandsFreeOS — Founding Customer',
  description: 'Paid once.',
  successUrl: 'https://app.test/founding/checkout/x?back=paid',
  cancelUrl: 'https://app.test/founding/checkout/x?back=cancel',
  customerEmail: 'dana@example.com',
  metadata: { workspace_id: 'ws-1' },
  idempotencyKey: 'founding-checkout-x',
};

const signed = (secret: string, body: string, at = Date.now()) => {
  const t = Math.floor(at / 1000);
  return { 'stripe-signature': `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}` };
};

describe('Stripe Checkout, in our own account', () => {
  it('needs only our own key — not the Connect client id — and carries no business account', async () => {
    const { provider, calls } = stripeWatching({ clientId: null });
    const page = await provider.platform.createCheckout(checkoutInput);
    expect(page).toEqual({
      sessionRef: 'cs_test_1',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
      expiresAt: new Date(1_900_000_000 * 1000).toISOString(),
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call.headers).not.toHaveProperty('stripe-account');
    expect(call.headers['authorization']).toBe('Bearer sk_test_ours');
    expect(call.headers['idempotency-key']).toBe('founding-checkout-x');
    const form = new URLSearchParams(call.body);
    expect(form.get('mode')).toBe('payment');
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('49700');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form.get('client_reference_id')).toBe(checkoutInput.checkoutId);
    expect(form.get('metadata[founding_checkout_id]')).toBe(checkoutInput.checkoutId);
    expect(form.get('payment_intent_data[metadata][founding_checkout_id]')).toBe(
      checkoutInput.checkoutId,
    );
    expect(form.get('customer_email')).toBe('dana@example.com');
  });

  it("verifies our own account's events with their own secret, and nothing else", () => {
    const { provider } = stripeWatching({ platformWebhookSecret: 'whsec_platform' });
    const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
    const verify = (headers: Record<string, string>) =>
      provider.platform.webhooks.verify({ rawBody: body, headers, url: 'https://x' });
    expect(provider.platform.webhooks.configured).toBe(true);
    expect(verify(signed('whsec_platform', body))).toBe(true);
    // Signed for the Connect endpoint, sent to ours: refused.
    expect(verify(signed('whsec_connect', body))).toBe(false);
    // An old signature is a replay.
    expect(verify(signed('whsec_platform', body, Date.now() - 10 * 60_000))).toBe(false);
    expect(verify({})).toBe(false);
  });

  it('verifies nothing until the secret is on the server', () => {
    const { provider } = stripeWatching({ platformWebhookSecret: null });
    const body = '{}';
    expect(provider.platform.webhooks.configured).toBe(false);
    expect(
      provider.platform.webhooks.verify({
        rawBody: body,
        headers: signed('whsec_platform', body),
        url: 'https://x',
      }),
    ).toBe(false);
  });

  it('reads a checkout event, and never one from a connected account', () => {
    const event = (extra: Record<string, unknown>) =>
      JSON.stringify({
        id: 'evt_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_1',
            metadata: { founding_checkout_id: 'co_1' },
            payment_status: 'paid',
            payment_intent: 'pi_1',
            amount_total: 49_700,
          },
        },
        ...extra,
      });
    expect(readStripeCheckoutEvent(event({}))).toEqual({
      id: 'evt_1',
      type: 'checkout.session.completed',
      sessionRef: 'cs_1',
      checkoutId: 'co_1',
      paymentStatus: 'paid',
      paymentRef: 'pi_1',
      amountTotal: 49_700,
    });
    expect(readStripeCheckoutEvent(event({ account: 'acct_somebody' }))).toBeNull();
    expect(readStripeCheckoutEvent(event({ type: 'payment_intent.succeeded' }))).toBeNull();
    expect(readStripeCheckoutEvent('not json')).toBeNull();
  });
});

// ---------- the whole loop, on the stand-in ----------

const PAID = 'test_worker_paid';
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

let owner: TestUser;
let workspaceId: string;
let organizationId: string;
let s: TestServices;
let app: FastifyInstance;

/** What the website's analytics was told: the stand-in for Opinly's API, as though OPINLY_API_KEY were set. */
const reported: { event: string; properties: Record<string, unknown>; opts: object }[] = [];
const opinly: Opinly = {
  track: async (event, properties, opts) => {
    reported.push({ event, properties, opts });
    return { ok: true };
  },
};

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

/** An approval as founding.approve writes it, with the link's token kept. */
async function approve(): Promise<{ token: string; grantId: string; email: string }> {
  const token = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const email = `${randomUUID()}@hfos.test`;
  const [grant] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${PAID}, ${organizationId}::uuid, now() + interval '14 days') returning id`,
  );
  await admin().execute(
    sql`insert into platform.founding_applications
          (offer_id, business_name, contact_name, email, status, claim_token_hash, claim_expires_at, grant_id)
        values (${PAID}, 'Checkout HVAC', 'Dana', ${email}, 'approved',
                ${createHash('sha256').update(token).digest()}, now() + interval '14 days', ${grant!.id}::uuid)`,
  );
  return { token, grantId: grant!.id, email };
}

async function checkout(checkoutId: string) {
  const [c] = await rows<{
    status: string;
    session_ref: string | null;
    session_url: string | null;
    payment_ref: string | null;
    problem: string;
  }>(
    admin(),
    sql`select status::text as status, session_ref, session_url, payment_ref, problem
        from platform.founding_checkouts where id = ${checkoutId}::uuid`,
  );
  return c!;
}

async function startPaying(): Promise<{ checkoutId: string; grantId: string; email: string }> {
  const { token, grantId, email } = await approve();
  const { output } = await executeCommand(
    api(),
    foundingStartCheckout,
    { token, workspaceId },
    actor(owner),
    meta(),
  );
  await drain();
  return { checkoutId: output.checkoutId, grantId, email };
}

beforeAll(async () => {
  owner = await createTestUser('founding-checkout-owner');
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Checkout HVAC' },
    actor(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  s = testServices({ opinly });
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
  // The stand-in's events arrive at this server's own routes, signed as Stripe signs them.
  s.payments.fake.setDeliver(async (delivery) => {
    const url = new URL(delivery.url);
    const res = await app.inject({
      method: 'POST',
      url: `${url.pathname}${url.search}`,
      headers: { 'content-type': 'application/json', ...delivery.headers },
      payload: delivery.body,
    });
    return { ok: res.statusCode >= 200 && res.statusCode < 300 };
  });
});
afterAll(async () => {
  await app?.close();
  await closeTestDbs();
});

beforeEach(async () => {
  reported.length = 0;
  await admin().execute(sql`delete from platform.founding_checkouts where offer_id = ${PAID}`);
  await admin().execute(sql`delete from platform.founding_applications where offer_id = ${PAID}`);
  await admin().execute(sql`delete from platform.founding_grants where offer_id = ${PAID}`);
  await admin().execute(sql`delete from platform.founding_offers where id = ${PAID}`);
  await admin().execute(sql`delete from app.workspace_plans where workspace_id = ${workspaceId}`);
  await admin().execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, starting_credit_cents, show_counter)
        values (${PAID}, 'Founding Customer', 5, 49700, 'open', 1000, false)`,
  );
});

describe('paying for a seat', () => {
  it('makes the page, and turns the seat on when Stripe says it is paid', async () => {
    const { checkoutId, grantId } = await startPaying();
    const opened = await checkout(checkoutId);
    expect(opened.status).toBe('open');
    expect(opened.session_url).toContain('/payments/fake/checkout/');

    const page = s.payments.fake.checkouts().find((p) => p.checkoutId === checkoutId)!;
    expect(page.amountCents).toBe(49_700);
    expect(page.successUrl).toBe(`http://localhost:3000/founding/checkout/${checkoutId}?back=paid`);
    await s.payments.fake.payCheckout(page.sessionRef);
    await drain();

    const paid = await checkout(checkoutId);
    expect(paid).toMatchObject({ status: 'paid', payment_ref: page.paymentRef, problem: '' });
    const [grant] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from platform.founding_grants where id = ${grantId}::uuid`,
    );
    expect(grant!.status).toBe('active');
    const [plan] = await rows<{ plan: string }>(
      admin(),
      sql`select plan::text as plan from app.workspace_plans where workspace_id = ${workspaceId}`,
    );
    expect(plan!.plan).toBe('founding_lifetime');
    // The money is ours: a platform charge, in no business's account.
    expect(s.payments.fake.platformCharges().some((c) => c.id === page.paymentRef)).toBe(true);
  });

  it("tells the website's analytics once, with what was taken and the address the application used", async () => {
    const { checkoutId, email } = await startPaying();
    expect(reported).toEqual([]);
    const page = s.payments.fake.checkouts().find((p) => p.checkoutId === checkoutId)!;
    await s.payments.fake.payCheckout(page.sessionRef);
    await drain();
    // The owner pays from an account under another address; the website only ever saw the application's.
    expect(owner.email).not.toBe(email);
    expect(reported).toEqual([
      {
        event: 'purchase',
        properties: { value: 497, currency: 'USD', offer: PAID },
        opts: { externalEventId: checkoutId, email },
      },
    ]);
  });

  it("pays on the stand-in's own page the way a person would, and lands back in the app", async () => {
    const { checkoutId } = await startPaying();
    const page = new URL((await checkout(checkoutId)).session_url!);
    const rendered = await app.inject({ method: 'GET', url: page.pathname });
    expect(rendered.statusCode).toBe(200);
    expect(rendered.body).toContain('Pay $497.00');

    const paid = await app.inject({
      method: 'POST',
      url: page.pathname,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'decision=pay',
    });
    expect(paid.statusCode).toBe(302);
    expect(paid.headers.location).toBe(
      `http://localhost:3000/founding/checkout/${checkoutId}?back=paid`,
    );
    await drain();
    expect((await checkout(checkoutId)).status).toBe('paid');

    // A used page says so rather than taking the money twice.
    expect((await app.inject({ method: 'GET', url: page.pathname })).statusCode).toBe(400);
  });

  it('closes the checkout when its page lapses, and keeps the seat reserved', async () => {
    const { checkoutId, grantId } = await startPaying();
    const page = s.payments.fake.checkouts().find((p) => p.checkoutId === checkoutId)!;
    await s.payments.fake.expireCheckout(page.sessionRef);
    await drain();
    expect((await checkout(checkoutId)).status).toBe('expired');
    expect(reported).toEqual([]);
    const [grant] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from platform.founding_grants where id = ${grantId}::uuid`,
    );
    expect(grant!.status).toBe('reserved');
  });

  it('refuses an event that is unsigned, forged, or signed for the Connect endpoint', async () => {
    const { checkoutId } = await startPaying();
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: 'cs_forged',
          metadata: { founding_checkout_id: checkoutId },
          payment_status: 'paid',
          payment_intent: 'pi_forged',
          amount_total: 49_700,
        },
      },
    });
    const send = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/stripe/platform',
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });
    expect((await send({})).statusCode).toBe(403);
    expect((await send(signed('whsec_somebody_else', body))).statusCode).toBe(403);
    expect((await send(signed(FAKE_STRIPE_WEBHOOK_SECRET, body))).statusCode).toBe(403);
    await drain();
    expect((await checkout(checkoutId)).status).toBe('open');

    // The same bytes, properly signed for our own account, are believed — once, however often they come.
    const good = signed(FAKE_STRIPE_PLATFORM_WEBHOOK_SECRET, body);
    expect((await send(good)).statusCode).toBe(200);
    expect((await send(good)).statusCode).toBe(200);
    await drain();
    expect((await checkout(checkoutId)).status).toBe('paid');
    const [deliveries] = await rows<{ n: number | string }>(
      admin(),
      sql`select count(*) as n from app.webhook_deliveries
          where kind = 'founding_checkout' and workspace_id = ${workspaceId}
            and dedupe_key = ${JSON.parse(body).id}`,
    );
    expect(Number(deliveries!.n)).toBe(1);
  });

  it('answers an event about a checkout nobody here has with a 200, and does nothing', async () => {
    const body = JSON.stringify({
      id: `evt_${randomUUID()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_elsewhere',
          metadata: { founding_checkout_id: randomUUID() },
          payment_status: 'paid',
          amount_total: 100,
        },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe/platform',
      headers: {
        'content-type': 'application/json',
        ...signed(FAKE_STRIPE_PLATFORM_WEBHOOK_SECRET, body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ignored: true });
  });
});
