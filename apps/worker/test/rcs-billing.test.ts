/**
 * Paying for RCS (0104), end to end on the stand-in provider: a business asks, the worker makes the Stripe page
 * with the fees on it, the page is paid, Stripe's signed event arrives at our own account's endpoint, the year
 * starts and a support ticket opens for HandsFreeOS to make the sender. A year on, the renewal is charged to the
 * card the page kept; a refused card opens a ticket instead and is never tried again on its own.
 *
 * The first block needs no database: it checks what the real Stripe adapter sends for an RCS page, and that an
 * RCS page's events are never read as a founding seat's.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  organizationCreate,
  RCS_FIRST_YEAR_CENTS,
  RCS_YEARLY_CENTS,
  rcsRequestCancel,
  rcsRequestPayRenewal,
  rcsRequestSubmit,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { rcsRequests } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs, type JobContext } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { FAKE_CARDS } from '../src/payments/fake';
import { createStripePayments, readStripeCheckoutEvent } from '../src/payments/stripe';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { planRcsRenewals } from '../src/telephony/rcs-billing';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-rcs-billing-${process.pid}`;

// ---------- the Stripe adapter, over a stubbed fetch ----------

describe('an RCS page at Stripe', () => {
  it('lists the fees, keeps the card for the renewal, and says it is an RCS request', async () => {
    const calls: { url: string; body: string }[] = [];
    const provider = createStripePayments({
      clientId: null,
      secretKey: 'sk_test_ours',
      publishableKey: null,
      webhookSecret: 'whsec_connect',
      platformWebhookSecret: 'whsec_platform',
      fetch: (async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body ?? '') });
        return new Response(
          JSON.stringify({ id: 'cs_rcs', url: 'https://checkout.stripe.com/c/pay/cs_rcs' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    await provider.platform.createCheckout({
      kind: 'rcs_request',
      checkoutId: 'b5c1a2f4-0000-4000-8000-000000000001',
      amountCents: 80_000,
      productName: 'RCS for Lone Star HVAC: the first year',
      description: null,
      lines: [
        { name: 'Carrier onboarding', description: 'Once.', amountCents: 50_000 },
        { name: 'Brand vetting by Aegis', description: 'Every year.', amountCents: 20_000 },
        { name: 'Setup by HandsFreeOS', description: 'Once.', amountCents: 10_000 },
      ],
      saveCard: true,
      successUrl: 'https://app.test/paid',
      cancelUrl: 'https://app.test/cancelled',
      customerEmail: null,
      metadata: {},
      idempotencyKey: 'rcs-checkout-1',
    });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('metadata[rcs_request_id]')).toBe('b5c1a2f4-0000-4000-8000-000000000001');
    expect(form.get('metadata[founding_checkout_id]')).toBeNull();
    expect(form.get('payment_intent_data[setup_future_usage]')).toBe('off_session');
    expect(
      [0, 1, 2].map((i) => [
        form.get(`line_items[${i}][price_data][product_data][name]`),
        form.get(`line_items[${i}][price_data][unit_amount]`),
      ]),
    ).toEqual([
      ['Carrier onboarding', '50000'],
      ['Brand vetting by Aegis', '20000'],
      ['Setup by HandsFreeOS', '10000'],
    ]);
  });

  it('reads an RCS page’s event as the RCS request’s, never as a founding seat’s', () => {
    const body = JSON.stringify({
      id: 'evt_rcs',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_rcs',
          client_reference_id: 'req_1',
          metadata: { rcs_request_id: 'req_1' },
          customer: 'cus_1',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 80_000,
        },
      },
    });
    expect(readStripeCheckoutEvent(body)).toMatchObject({
      checkoutId: null,
      rcsRequestId: 'req_1',
      customerRef: 'cus_1',
      amountTotal: 80_000,
    });
  });
});

// ---------- the whole loop, on the stand-in ----------

const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;

const brand = {
  displayName: 'Lone Star HVAC',
  description: 'Heating and cooling repair in Houston.',
  color: '#1A73E8',
  website: 'https://lonestar.example.com',
  privacyUrl: 'https://lonestar.example.com/privacy',
  termsUrl: 'https://lonestar.example.com/terms',
  phone: '(713) 555-0100',
  email: 'hello@lonestar.example.com',
};

let owner: TestUser;
let s: TestServices;
let app: FastifyInstance;

async function drain(workspaceId: string, timeoutMs = 15_000): Promise<void> {
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
    if (passes.some((p) => p.retried + p.failed > 0)) {
      const errors = await rows(
        admin(),
        sql`select 'outbox' as source, event_type as what, last_error from app.outbox
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'webhook', kind, last_error from app.webhook_deliveries
              where workspace_id = ${workspaceId} and last_error is not null
            union all select 'job', kind, last_error from app.scheduled_jobs
              where workspace_id = ${workspaceId} and last_error is not null`,
      );
      throw new Error(`worker work failed: ${JSON.stringify(errors)}`);
    }
    if (!passes.some((p) => p.claimed > 0)) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
  }
}

/** A business with a working number, ready to ask for RCS. */
async function business(name: string) {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    actor(owner),
    meta(),
  );
  await rows(
    admin(),
    sql`insert into app.phone_numbers (workspace_id, e164, number_type, status)
        values (${output.workspaceId},
          ${`+1713${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`}, 'local', 'active')`,
  );
  return { workspaceId: output.workspaceId, organizationId: output.organizationId };
}

const requestOf = async (id: string) =>
  (await admin().select().from(rcsRequests).where(eq(rcsRequests.id, id)))[0]!;

/** Asks, makes the page, and pays it with `instrument`. */
async function askAndPay(workspaceId: string, instrument?: string) {
  const { output } = await executeCommand(
    api(),
    rcsRequestSubmit,
    { workspaceId, brand },
    actor(owner),
    meta(),
  );
  await drain(workspaceId);
  const opened = await requestOf(output.rcsRequestId);
  expect(opened.status).toBe('open');
  await s.payments.fake.payCheckout(opened.sessionRef!, instrument ? { instrument } : {});
  await drain(workspaceId);
  return output.rcsRequestId;
}

/** A year passes: the paid year ends now, and the hourly sweep runs. */
async function aYearLater(workspaceId: string, organizationId: string, id: string) {
  await asWorker(testDbs().worker.db, { workspaceId, organizationId }, (tx) =>
    tx
      .update(rcsRequests)
      .set({ paidThrough: new Date(Date.now() - 60_000) })
      .where(eq(rcsRequests.id, id)),
  );
  await sweep();
  await drain(workspaceId);
}

/** The hourly sweep for paid years that are up, run now. */
const sweep = () =>
  planRcsRenewals({
    ...s,
    job: { payload: {} },
    scope: {},
    attempt: 1,
    now: Date.now(),
  } as unknown as JobContext);

beforeAll(async () => {
  owner = await createTestUser('rcs-billing-owner');
  s = testServices();
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

describe('paying for RCS', () => {
  it('takes $800 with the fees listed, then opens a ticket for support to make the sender', async () => {
    const { workspaceId } = await business('Paying For RCS Co');
    const id = await askAndPay(workspaceId);

    const page = s.payments.fake.checkouts().find((p) => p.checkoutId === id)!;
    expect(page).toMatchObject({
      kind: 'rcs_request',
      amountCents: RCS_FIRST_YEAR_CENTS,
      saveCard: true,
    });
    expect(page.lines.map((l) => l.amountCents)).toEqual([50_000, 20_000, 10_000]);
    expect(page.successUrl).toContain(`/app/w/${workspaceId}/settings/texting?rcs=paid`);

    const paid = await requestOf(id);
    expect(paid).toMatchObject({
      status: 'paid',
      paidCents: RCS_FIRST_YEAR_CENTS,
      yearlyCents: RCS_YEARLY_CENTS,
    });
    expect(paid.cardRef).toBeTruthy();
    expect(paid.customerRef).toBeTruthy();
    const days = (paid.paidThrough!.getTime() - paid.paidAt!.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(365);
    expect(days).toBeLessThanOrEqual(366);

    // The ticket support works from: the business's words, and a note only staff see.
    const [ticket] = await rows<{
      id: string;
      number: string;
      subject: string;
      channel: string;
      workspace_id: string;
      requester_email: string;
    }>(
      admin(),
      sql`select id, number, subject, channel::text as channel, workspace_id, requester_email::text as requester_email
          from platform.tickets where id = ${paid.ticketId}`,
    );
    expect(ticket).toMatchObject({
      subject: 'RCS sender for Paying For RCS Co',
      channel: 'in_app',
      workspace_id: workspaceId,
      requester_email: owner.email,
    });
    expect(Number(ticket!.number)).toBe(paid.ticketNumber);
    const messages = await rows<{ author: string; internal: boolean; body_text: string }>(
      admin(),
      sql`select author::text as author, internal, body_text from platform.ticket_messages
          where ticket_id = ${ticket!.id} order by internal`,
    );
    expect(messages.map((m) => [m.author, m.internal])).toEqual([
      ['customer', false],
      ['staff', true],
    ]);
    expect(messages[0]!.body_text).toContain('Name customers see: Lone Star HVAC');
    expect(messages[0]!.body_text).toContain('Logo: not sent yet');
    expect(messages[1]!.body_text).toContain('Make the RCS sender in the Twilio console');
    expect(messages[1]!.body_text).toContain('Renews for $215');
    // Told the way every in-app ticket is: support's phones hear, and the AI is asked for a draft.
    const [opened] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from app.events
          where event_type = 'support_ticket.opened' and entity_id = ${ticket!.id}`,
    );
    expect(opened!.n).toBe(1);

    // Asking again is refused, and says the ticket.
    await expect(
      executeCommand(api(), rcsRequestSubmit, { workspaceId, brand }, actor(owner), meta()),
    ).rejects.toMatchObject({ rule: 'rcs_request_paid' });

    // Stripe sending the same event again changes nothing.
    const again = s.payments.fake
      .webhooks()
      .filter((w) => w.type === 'checkout.session.completed')
      .at(-1)!;
    await app.inject({
      method: 'POST',
      url: '/webhooks/stripe/platform',
      headers: { 'content-type': 'application/json', ...again.headers },
      payload: again.body,
    });
    await drain(workspaceId);
    const [tickets] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from platform.tickets where workspace_id = ${workspaceId}`,
    );
    expect(tickets!.n).toBe(1);
  });

  it('renews a year later on the kept card, once however often the sweep runs', async () => {
    const { workspaceId, organizationId } = await business('Renewing RCS Co');
    const id = await askAndPay(workspaceId);
    const before = s.payments.fake.platformCharges().length;
    await aYearLater(workspaceId, organizationId, id);
    const renewed = await requestOf(id);
    expect(renewed.renewalCount).toBe(1);
    expect(renewed.paidThrough!.getTime()).toBeGreaterThan(Date.now() + 360 * 86_400_000);
    const charges = s.payments.fake.platformCharges().slice(before);
    expect(charges.map((c) => [c.amountCents, c.status])).toEqual([
      [RCS_YEARLY_CENTS, 'succeeded'],
    ]);
    // The sweep again, with the new year not up: nothing is due, nothing is charged.
    await sweep();
    await drain(workspaceId);
    expect((await requestOf(id)).renewalCount).toBe(1);
    expect(s.payments.fake.platformCharges().slice(before)).toHaveLength(1);
  });

  it('opens a ticket when the card refuses the renewal, and never tries it again on its own', async () => {
    const { workspaceId, organizationId } = await business('Refused Renewal Co');
    const id = await askAndPay(workspaceId, FAKE_CARDS.failsOffSession);
    await aYearLater(workspaceId, organizationId, id);
    const refused = await requestOf(id);
    expect(refused.renewalCount).toBe(0);
    expect(refused.renewalFailedAt).toBeTruthy();
    expect(refused.renewalProblem).toBeTruthy();
    const subjects = await rows<{ subject: string }>(
      admin(),
      sql`select subject from platform.tickets where workspace_id = ${workspaceId} order by created_at`,
    );
    expect(subjects.map((t) => t.subject)).toEqual([
      'RCS sender for Refused Renewal Co',
      'RCS renewal for Refused Renewal Co didn’t go through',
    ]);
    const charged = s.payments.fake.platformCharges().length;
    await sweep();
    await drain(workspaceId);
    expect(s.payments.fake.platformCharges()).toHaveLength(charged);

    // The business pays it on a page of its own, with another card: that year renews, on that card.
    const asked = await executeCommand(
      api(),
      rcsRequestPayRenewal,
      { workspaceId },
      actor(owner),
      meta(),
    );
    expect(asked.output.checkoutUrl).toBeNull();
    await drain(workspaceId);
    const waiting = await requestOf(id);
    expect(waiting.renewalSessionUrl).toContain('/payments/fake/checkout/');
    const page = s.payments.fake
      .checkouts()
      .find((p) => p.sessionRef === waiting.renewalSessionRef)!;
    expect(page).toMatchObject({ amountCents: RCS_YEARLY_CENTS, saveCard: true });
    expect(page.metadata['rcs_renewal_for']).toBe(refused.paidThrough!.toISOString());
    // Asking again is the same page.
    const again = await executeCommand(
      api(),
      rcsRequestPayRenewal,
      { workspaceId },
      actor(owner),
      meta(),
    );
    expect(again.output.checkoutUrl).toBe(waiting.renewalSessionUrl);
    await s.payments.fake.payCheckout(page.sessionRef);
    await drain(workspaceId);
    const renewed = await requestOf(id);
    expect(renewed).toMatchObject({ renewalCount: 1, renewalFailedAt: null, renewalProblem: null });
    expect(renewed.cardRef).not.toBe(refused.cardRef);
    expect(renewed.paidThrough!.getTime()).toBeGreaterThan(refused.paidThrough!.getTime());
    await expect(
      executeCommand(api(), rcsRequestPayRenewal, { workspaceId }, actor(owner), meta()),
    ).rejects.toMatchObject({ rule: 'rcs_renewal_not_due' });

    // A year on, the new card is the one charged, and it goes through.
    const before = s.payments.fake.platformCharges().length;
    await aYearLater(workspaceId, organizationId, id);
    expect((await requestOf(id)).renewalCount).toBe(2);
    expect(
      s.payments.fake
        .platformCharges()
        .slice(before)
        .map((c) => c.status),
    ).toEqual(['succeeded']);
  });

  it('gives up on an unpaid request, and stops a paid one renewing with a ticket saying so', async () => {
    const { workspaceId, organizationId } = await business('Changing Mind Co');
    const { output } = await executeCommand(
      api(),
      rcsRequestSubmit,
      { workspaceId, brand },
      actor(owner),
      meta(),
    );
    await drain(workspaceId);
    // Pressing Pay again picks the same page back up.
    const twice = await executeCommand(
      api(),
      rcsRequestSubmit,
      { workspaceId, brand },
      actor(owner),
      meta(),
    );
    expect(twice.output).toMatchObject({ rcsRequestId: output.rcsRequestId, status: 'open' });
    expect(twice.output.checkoutUrl).toContain('/payments/fake/checkout/');
    await executeCommand(api(), rcsRequestCancel, { workspaceId }, actor(owner), meta());
    expect((await requestOf(output.rcsRequestId)).status).toBe('cancelled');

    const id = await askAndPay(workspaceId);
    expect(id).not.toBe(output.rcsRequestId);
    await executeCommand(api(), rcsRequestCancel, { workspaceId }, actor(owner), meta());
    const stopped = await requestOf(id);
    expect(stopped).toMatchObject({ status: 'paid' });
    expect(stopped.stoppedAt).toBeTruthy();
    const subjects = await rows<{ subject: string }>(
      admin(),
      sql`select subject from platform.tickets where workspace_id = ${workspaceId} order by created_at`,
    );
    expect(subjects.map((t) => t.subject)).toEqual([
      'RCS sender for Changing Mind Co',
      'Stop renewing RCS for Changing Mind Co',
    ]);
    // Stopped: a year on, nothing is charged.
    const charged = s.payments.fake.platformCharges().length;
    await aYearLater(workspaceId, organizationId, id);
    expect(s.payments.fake.platformCharges()).toHaveLength(charged);
  });
});
