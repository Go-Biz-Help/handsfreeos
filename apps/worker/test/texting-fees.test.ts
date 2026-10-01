/**
 * What registering for texting costs, passed on at cost (0105), end to end on the stand-in carrier and Stripe:
 * a local registration waits for its fees, paid on a page whose signed event arrives at our own endpoint, then
 * goes to the carriers; its campaign's months are charged to the card that page kept; a card that says no is
 * paid with another on a page of its own; and with paying online switched off, nothing is stranded.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  executeCommand,
  organizationCreate,
  phoneNumberBuy,
  registrationSubmit,
  textingFeePay,
  type HumanActor,
} from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { telephonyRegistrations, textingFees } from '@hfos/db/schema';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs, type JobContext } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { FAKE_CARDS } from '../src/payments/fake';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { planTextingMonths } from '../src/telephony/texting-fees';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-texting-fees-${process.pid}`;
const actor = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const business = {
  legalName: 'Fees Test HVAC LLC',
  businessType: 'llc',
  ein: '12-3456789',
  website: 'https://example.com',
  address: { line1: '4410 Westpark Dr', city: 'Houston', state: 'TX', postalCode: '77027' },
  contact: {
    firstName: 'Dale',
    lastName: 'Ramsey',
    email: 'dale@example.com',
    phone: '(713) 555-0161',
  },
  useCase: 'customer_care',
  messageSamples: [
    'Hi Mike, this is Fees HVAC. Marco is on the way. Reply STOP to opt out.',
    'Hi Mike, your estimate for the new AC unit is ready. Reply with questions or STOP to opt out.',
  ],
  optInDescription:
    'Customers give us their cell number when they book a visit and agree to texts about it.',
  monthlyVolume: 'under_1000',
};

let owner: TestUser;
let s: TestServices;
let app: FastifyInstance;

async function drain(
  workspaceId: string,
  opts: { until?: () => Promise<boolean>; timeoutMs?: number } = {},
) {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
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
    const busy = passes.some((p) => p.claimed > 0);
    if (opts.until ? await opts.until() : !busy) return;
    if (Date.now() > deadline) throw new Error('the worker did not finish in time');
    if (!busy) await sleep(50);
  }
}

const sweep = () =>
  planTextingMonths({
    ...s,
    job: { payload: {} },
    scope: {},
    attempt: 1,
    now: Date.now(),
  } as unknown as JobContext);

const feesOf = (workspaceId: string) =>
  admin()
    .select()
    .from(textingFees)
    .where(eq(textingFees.workspaceId, workspaceId))
    .orderBy(textingFees.createdAt);

const campaignOf = async (workspaceId: string) =>
  (
    await admin()
      .select()
      .from(telephonyRegistrations)
      .where(eq(telephonyRegistrations.workspaceId, workspaceId))
  ).find((r) => r.kind === 'a2p_campaign');

/** A business with a working local number. */
async function businessWithNumber(name: string) {
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: name },
    actor(owner),
    meta(),
  );
  const local = `+1713${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}7`;
  await executeCommand(
    api(),
    phoneNumberBuy,
    { workspaceId: output.workspaceId, e164: local, numberType: 'local' },
    actor(owner),
    meta(),
  );
  await drain(output.workspaceId);
  return { workspaceId: output.workspaceId, organizationId: output.organizationId };
}

const submit = (workspaceId: string, monthlyVolume = 'under_1000') =>
  executeCommand(
    api(),
    registrationSubmit,
    { workspaceId, kind: 'a2p_10dlc', business: { ...business, monthlyVolume } },
    actor(owner),
    meta(),
  );

/** Pays the open page as a person would, on the stand-in: the signed event comes back through our webhook. */
async function payPage(workspaceId: string, instrument?: string) {
  const open = (await feesOf(workspaceId)).find((f) => f.status === 'open');
  if (!open?.sessionRef) throw new Error('no page is waiting');
  await s.payments.fake.payCheckout(open.sessionRef, instrument ? { instrument } : {});
  return open;
}

/** A month passes since the campaign was approved. */
async function monthsPass(workspaceId: string, organizationId: string, months: number) {
  const c = (await campaignOf(workspaceId))!;
  await asWorker(testDbs().worker.db, { workspaceId, organizationId }, (tx) =>
    tx
      .update(telephonyRegistrations)
      .set({ approvedAt: new Date(c.approvedAt!.getTime() - months * 31 * 86_400_000) })
      .where(eq(telephonyRegistrations.id, c.id)),
  );
}

beforeAll(async () => {
  owner = await createTestUser('texting-fees-owner');
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: null,
    webOrigins: ['http://localhost:3000'],
  });
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

describe('the registration’s fees', () => {
  it('holds the registration back until its $19.50 is paid on a page, then sends it', async () => {
    const { workspaceId } = await businessWithNumber('Fees Page Co');
    const before = s.telephony.registrations.length;
    const sent = await submit(workspaceId);
    expect(sent.output.fee).toMatchObject({ amountCents: 1_950 });
    await drain(workspaceId);
    // A page with the carriers' lines on it, and nothing at the carriers yet.
    const [fee] = await feesOf(workspaceId);
    expect(fee).toMatchObject({ status: 'open', purpose: 'registration', amountCents: 1_950 });
    const page = s.payments.fake.checkouts().find((p) => p.checkoutId === fee!.id)!;
    expect(page).toMatchObject({ kind: 'texting_fee', amountCents: 1_950, saveCard: true });
    expect(page.lines.map((l) => [l.name, l.amountCents])).toEqual([
      ['Brand registration', 450],
      ['Campaign review', 1_500],
    ]);
    expect(s.telephony.registrations.length).toBe(before);

    await payPage(workspaceId);
    await drain(workspaceId, {
      until: async () => (await campaignOf(workspaceId))?.status === 'approved',
    });
    const [paid] = await feesOf(workspaceId);
    expect(paid).toMatchObject({ status: 'paid', paidCents: 1_950 });
    expect(paid!.cardRef).toBeTruthy();
    expect(s.telephony.registrations.slice(before).map((r) => r.kind)).toEqual([
      'a2p_customer_profile',
      'a2p_trust_product',
      'a2p_brand',
      'a2p_campaign',
    ]);
  });

  it('adds the brand’s vetting for a business that texts 1,000 or more a month', async () => {
    const { workspaceId } = await businessWithNumber('Fees Vetting Co');
    const sent = await submit(workspaceId, '1000_10000');
    expect(sent.output.fee).toMatchObject({ amountCents: 6_100 });
    // Sending it again with the same answers keeps the same fee, page and all.
    await drain(workspaceId);
    const again = await submit(workspaceId, '1000_10000');
    expect(again.output.fee?.id).toBe(sent.output.fee!.id);
    expect((await feesOf(workspaceId)).map((f) => f.status)).toEqual(['open']);
  });
});

describe('the campaign’s month', () => {
  it('charges $10 a month to the kept card, once a month however often the sweep runs', async () => {
    const { workspaceId, organizationId } = await businessWithNumber('Fees Monthly Co');
    await submit(workspaceId);
    await drain(workspaceId);
    await payPage(workspaceId);
    await drain(workspaceId, {
      until: async () => (await campaignOf(workspaceId))?.status === 'approved',
    });
    const charges = s.payments.fake.platformCharges().length;
    await sweep();
    await drain(workspaceId);
    await sweep();
    await drain(workspaceId);
    const months = (await feesOf(workspaceId)).filter((f) => f.purpose === 'month');
    expect(months.map((f) => [f.monthIndex, f.status, f.amountCents])).toEqual([
      [0, 'paid', 1_000],
    ]);
    expect(
      s.payments.fake
        .platformCharges()
        .slice(charges)
        .map((c) => c.amountCents),
    ).toEqual([1_000]);

    await monthsPass(workspaceId, organizationId, 1);
    await sweep();
    await drain(workspaceId);
    expect(
      (await feesOf(workspaceId)).filter((f) => f.purpose === 'month').map((f) => f.monthIndex),
    ).toEqual([0, 1]);
  });

  it('stops at a card that says no, until the business pays with another card', async () => {
    const { workspaceId, organizationId } = await businessWithNumber('Fees Refused Co');
    await submit(workspaceId);
    await drain(workspaceId);
    // A card that pays here and then, but says no when charged later without them there.
    await payPage(workspaceId, FAKE_CARDS.failsOffSession);
    await drain(workspaceId, {
      until: async () => (await campaignOf(workspaceId))?.status === 'approved',
    });
    await sweep();
    await drain(workspaceId);
    const refused = (await feesOf(workspaceId)).find((f) => f.purpose === 'month')!;
    // Refused, said why, and a page is already waiting to pay it with another card.
    expect(refused).toMatchObject({ status: 'open', monthIndex: 0 });
    expect(refused.problem).toBeTruthy();
    // No more months while one waits on the business.
    await monthsPass(workspaceId, organizationId, 1);
    await sweep();
    await drain(workspaceId);
    expect((await feesOf(workspaceId)).filter((f) => f.purpose === 'month')).toHaveLength(1);

    const asked = await executeCommand(
      api(),
      textingFeePay,
      { workspaceId, textingFeeId: refused.id },
      actor(owner),
      meta(),
    );
    expect(asked.output.checkoutUrl).toBe(refused.sessionUrl);
    await payPage(workspaceId);
    await drain(workspaceId);
    const months = (await feesOf(workspaceId)).filter((f) => f.purpose === 'month');
    expect(months.map((f) => f.status)).toEqual(['paid']);
    // The new card is the one charged from now on: the next month goes through.
    await sweep();
    await drain(workspaceId);
    expect(
      (await feesOf(workspaceId))
        .filter((f) => f.purpose === 'month')
        .map((f) => [f.monthIndex, f.status]),
    ).toEqual([
      [0, 'paid'],
      [1, 'paid'],
    ]);
  });
});

describe('paying online switched off', () => {
  it('lets the registration go uncharged rather than strand it', async () => {
    const { workspaceId } = await businessWithNumber('Fees Off Co');
    const webhooks = s.payments.providers.stripe.platform.webhooks as { configured: boolean };
    webhooks.configured = false;
    try {
      const before = s.telephony.registrations.length;
      await submit(workspaceId);
      await drain(workspaceId, {
        until: async () => s.telephony.registrations.length > before,
      });
      const [fee] = await feesOf(workspaceId);
      expect(fee).toMatchObject({ status: 'waived', paidAt: null });
      expect(fee!.problem).toContain('isn’t switched on');
    } finally {
      webhooks.configured = true;
    }
  });
});
