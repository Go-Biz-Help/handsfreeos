/**
 * Billing for a founding plan (20261027023600, the owner's call of 2026-11-08), end to end on the stand-in provider:
 *
 * - a declined default card falls through to the backups, in order, and each decline is kept on its card;
 * - a declined payment is tried again once a day, at a random time in the next day, and stops after the last;
 * - Try my cards now charges the cards at once;
 * - a later payment day is charged for the days it adds, and only then moves; an earlier one moves at once and takes
 *   the days given up off the next payment;
 * - asking for more time opens a ticket, and a grant pauses the retries until that day.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  billingAnswerMoreTime,
  billingAskMoreTime,
  billingChangePayDay,
  billingGet,
  billingPayDayQuote,
  billingPayNow,
  billingRecordCard,
  billingRemoveCard,
  billingSetDefaultCard,
  billingStatus,
  executeCommand,
  executeQuery,
  foundingStartCheckout,
  nextPlanRetryAt,
  organizationCreate,
  paymentBlockOf,
  PLAN_RETRY_DAYS,
  type HumanActor,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processDeliveries } from '../src/deliveries';
import { planFoundingRenewals } from '../src/founding/checkout';
import { declinedWords } from '../src/founding/billing';
import { planCardReturnUrl } from '../src/founding/plan-card-routes';
import { handlers } from '../src/handlers/index';
import { buildHttpServer } from '../src/http/server';
import { processJobs, type JobContext } from '../src/jobs';
import { processOnce } from '../src/outbox';
import { FAKE_CARDS } from '../src/payments/fake';
import { processors } from '../src/processors/index';
import { jobs } from '../src/scheduled';
import { systemActor } from '../src/services';
import { testServices, type TestServices } from './helpers';

const WORKER_ID = `vitest-plan-billing-${process.pid}`;
const PAID = 'test_plan_billing_yearly';
const DAY = 86_400_000;

// ---------- the rules, with no database ----------

describe('when the next retry is', () => {
  it('is a random moment in the next day, for 14 days, then none', () => {
    const from = new Date('2026-11-08T10:00:00Z');
    const first = nextPlanRetryAt(from, 0, 0)!;
    expect(first.toISOString()).toBe('2026-11-09T10:00:00.000Z');
    const late = nextPlanRetryAt(from, 0, 0.99)!;
    expect(late.getTime() - from.getTime()).toBeGreaterThan(DAY);
    expect(late.getTime() - from.getTime()).toBeLessThan(2 * DAY);
    expect(nextPlanRetryAt(from, PLAN_RETRY_DAYS - 1, 0.5)).not.toBeNull();
    expect(nextPlanRetryAt(from, PLAN_RETRY_DAYS, 0.5)).toBeNull();
  });
});

describe('the failed-payment page', () => {
  const failedAt = '2026-11-08T10:00:00.000Z';
  const at = (hours: number) => new Date(new Date(failedAt).getTime() + hours * 3_600_000);

  it('shows from the next screen, can be skipped for a day, and not after 72 hours', () => {
    expect(paymentBlockOf(null, at(1), null)).toBeNull();
    expect(paymentBlockOf({ failedAt, moreTimeUntil: null }, at(1), null)).toMatchObject({
      show: true,
      canSkip: true,
    });
    // Skipped until tomorrow: hidden until then.
    const skipped = at(25).toISOString();
    expect(paymentBlockOf({ failedAt, moreTimeUntil: null }, at(2), skipped)?.show).toBe(false);
    expect(paymentBlockOf({ failedAt, moreTimeUntil: null }, at(26), skipped)?.show).toBe(true);
    // From 72 hours, a skip counts for nothing.
    expect(
      paymentBlockOf({ failedAt, moreTimeUntil: null }, at(73), at(90).toISOString()),
    ).toMatchObject({ show: true, canSkip: false });
  });

  it('goes away while staff have given more time', () => {
    expect(
      paymentBlockOf({ failedAt, moreTimeUntil: at(200).toISOString() }, at(100), null),
    ).toBeNull();
    expect(
      paymentBlockOf({ failedAt, moreTimeUntil: at(200).toISOString() }, at(201), null)?.show,
    ).toBe(true);
  });
});

describe('the words for declines', () => {
  it('says the one reason, or that every card was declined', () => {
    expect(declinedWords(['Your card was declined.'])).toBe('Your card was declined.');
    expect(declinedWords(['Insufficient funds.', 'Your card was declined.'])).toBe(
      'Your default card and 1 backup card were all declined. Your default card: Insufficient funds.',
    );
  });

  it('brings people back to the page they added the card from, never one they name', () => {
    expect(planCardReturnUrl('https://app.test', 'w1', { from: 'payment', payNow: true })).toBe(
      'https://app.test/payment/w1?payNow=1',
    );
    expect(planCardReturnUrl('https://app.test', 'w1', {})).toBe(
      'https://app.test/app/w/w1/settings/usage',
    );
  });
});

// ---------- end to end ----------

const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = () => ({ correlationId: randomUUID(), channel: 'test' as const });
const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const system = () => systemActor({ workspaceId, organizationId });

let owner: TestUser;
let member: TestUser;
let staff: TestUser;
let workspaceId: string;
let organizationId: string;
let s: TestServices;
let app: FastifyInstance;

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

const sweep = async () => {
  await planFoundingRenewals({
    ...s,
    job: { payload: {} },
    scope: {},
    attempt: 1,
    now: Date.now(),
  } as unknown as JobContext);
  await drain();
};

/** A yearly seat, bought on Stripe's page with the card `instrument`. */
async function buy(instrument: string = FAKE_CARDS.succeeds) {
  const token = `${randomUUID()}${randomUUID()}`.replaceAll('-', '');
  const [grant] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${PAID}, ${organizationId}::uuid, now() + interval '14 days') returning id`,
  );
  await admin().execute(
    sql`insert into platform.founding_applications
          (offer_id, business_name, contact_name, email, status, claim_token_hash, claim_expires_at, grant_id)
        values (${PAID}, 'Billing HVAC', 'Dana', ${`${randomUUID()}@hfos.test`}, 'approved',
                ${createHash('sha256').update(token).digest()}, now() + interval '14 days', ${grant!.id}::uuid)`,
  );
  const { output } = await executeCommand(
    api(),
    foundingStartCheckout,
    { token, workspaceId },
    human(owner),
    meta(),
  );
  await drain();
  const page = s.payments.fake.checkouts().find((p) => p.checkoutId === output.checkoutId)!;
  await s.payments.fake.payCheckout(page.sessionRef, { instrument });
  await drain();
  return { grantId: grant!.id, page };
}

/** A card added from Stripe's page, as the worker's route writes it. */
async function addCard(instrument: string, makeDefault = false) {
  const platform = s.payments.providers.stripe.platform;
  const { customerRef } = await platform.ensureCustomer({
    customerRef: null,
    name: 'Billing HVAC',
    email: null,
    phone: null,
    idempotencyKey: `test-${randomUUID()}`,
  });
  const token = s.payments.fake.page.tokenise({ instrument, method: 'card' });
  const saved = await platform.saveMethod({
    customerRef,
    sourceToken: token,
    idempotencyKey: randomUUID(),
  });
  const { output } = await executeCommand(
    testDbs().worker.db,
    billingRecordCard,
    {
      workspaceId,
      customerRef,
      cardRef: saved.token,
      brand: saved.brand,
      last4: saved.last4,
      expiryMonth: saved.expiryMonth,
      expiryYear: saved.expiryYear,
      makeDefault,
      addedBy: owner.id,
    },
    system(),
    meta(),
  );
  return output.cardId;
}

async function planNow() {
  const [p] = await rows<{
    status: string;
    current_period_end: string | null;
    renewal_count: number;
    renewal_failed_at: string | null;
    renewal_problem: string | null;
    retry_count: number;
    next_retry_at: string | null;
    retry_from: string | null;
    pay_day_credit_cents: number;
    more_time_until: string | null;
  }>(
    admin(),
    sql`select status::text as status, current_period_end::text as current_period_end, renewal_count,
          renewal_failed_at::text as renewal_failed_at, renewal_problem, retry_count,
          next_retry_at::text as next_retry_at, retry_from::text as retry_from, pay_day_credit_cents,
          more_time_until::text as more_time_until
        from app.workspace_plans where workspace_id = ${workspaceId}`,
  );
  return p!;
}

async function cardsNow() {
  return rows<{
    id: string;
    is_default: boolean;
    last_declined_at: string | null;
    card_last4: string | null;
  }>(
    admin(),
    sql`select id, is_default, last_declined_at::text as last_declined_at, card_last4
        from app.plan_cards where workspace_id = ${workspaceId} order by is_default desc, created_at`,
  );
}

const periodUp = () =>
  admin().execute(
    sql`update app.workspace_plans set current_period_end = now() - interval '1 minute'
        where workspace_id = ${workspaceId}`,
  );
const retryDue = () =>
  admin().execute(
    sql`update app.workspace_plans set next_retry_at = now() - interval '1 minute'
        where workspace_id = ${workspaceId}`,
  );

beforeAll(async () => {
  [owner, member, staff] = await Promise.all([
    createTestUser('plan-billing-owner', { fullName: 'Dana Owner' }),
    createTestUser('plan-billing-member'),
    createTestUser('plan-billing-staff'),
  ]);
  const { output } = await executeCommand(
    api(),
    organizationCreate,
    { businessName: 'Billing HVAC' },
    human(owner),
    meta(),
  );
  workspaceId = output.workspaceId;
  organizationId = output.organizationId;
  await admin().execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${workspaceId}, ${member.id}, 'member')`,
  );
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin')
        on conflict (user_id) do update set role = 'admin', status = 'active'`,
  );
  s = testServices({});
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
  await admin().execute(
    sql`update platform.founding_offers set status = 'closed' where id = ${PAID} and status = 'open'`,
  );
  await app?.close();
  await closeTestDbs();
});

beforeEach(async () => {
  await admin().execute(
    sql`delete from app.plan_time_requests where workspace_id = ${workspaceId}`,
  );
  await admin().execute(sql`delete from platform.founding_checkouts where offer_id = ${PAID}`);
  await admin().execute(sql`delete from platform.founding_applications where offer_id = ${PAID}`);
  await admin().execute(sql`delete from platform.founding_grants where offer_id = ${PAID}`);
  await admin().execute(sql`delete from platform.founding_offers where id = ${PAID}`);
  await admin().execute(sql`delete from app.workspace_plans where workspace_id = ${workspaceId}`);
  await admin().execute(sql`delete from app.plan_cards where workspace_id = ${workspaceId}`);
  await admin().execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, starting_credit_cents, show_counter, paid_yearly)
        values (${PAID}, 'Founding Customer', 5, 49700, 'open', 0, false, true)`,
  );
});

describe('the cards', () => {
  it('keeps the card the first payment used as the default, and adds backups behind it', async () => {
    await buy();
    const [first] = await cardsNow();
    expect(first).toMatchObject({ is_default: true });
    const backup = await addCard(FAKE_CARDS.disputes);
    const cards = await cardsNow();
    expect(cards.map((c) => [c.id === backup, c.is_default])).toEqual([
      [false, true],
      [true, false],
    ]);

    const got = await executeQuery(api(), billingGet, { workspaceId }, human(owner), meta());
    expect(got.billed).toBe(true);
    expect(got.cards.map((c) => c.isDefault)).toEqual([true, false]);
    expect(got.payDayBounds).not.toBeNull();
  });

  it('lets the default change, and refuses to remove the default', async () => {
    await buy();
    const backup = await addCard(FAKE_CARDS.disputes);
    const [def] = await cardsNow();
    await expect(
      executeCommand(
        api(),
        billingRemoveCard,
        { workspaceId, cardId: def!.id },
        human(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'plan_card_is_default' });
    await executeCommand(
      api(),
      billingSetDefaultCard,
      { workspaceId, cardId: backup },
      human(owner),
      meta(),
    );
    const [p] = await rows<{ stripe_card_id: string; card_ref: string }>(
      admin(),
      sql`select p.stripe_card_id, c.card_ref from app.workspace_plans p
          join app.plan_cards c on c.workspace_id = p.workspace_id and c.is_default
          where p.workspace_id = ${workspaceId}`,
    );
    // The code from before cards had rows still reads the default from the plan.
    expect(p!.stripe_card_id).toBe(p!.card_ref);
    await executeCommand(
      api(),
      billingRemoveCard,
      { workspaceId, cardId: def!.id },
      human(owner),
      meta(),
    );
    expect((await cardsNow()).map((c) => c.id)).toEqual([backup]);
  });

  it('keeps the one card while the plan renews on it, and tops the balance up from it (5a)', async () => {
    await buy();
    const [only] = await cardsNow();
    await expect(
      executeCommand(
        api(),
        billingRemoveCard,
        { workspaceId, cardId: only!.id },
        human(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'plan_card_last_one' });
    const [w] = await rows<{ method_token: string | null; card_ref: string }>(
      admin(),
      sql`select w.method_token, c.card_ref from app.usage_wallets w
          join app.plan_cards c on c.workspace_id = w.workspace_id and c.is_default
          where w.workspace_id = ${workspaceId}`,
    );
    expect(w!.method_token).toBe(w!.card_ref);
  });

  it('is for whoever manages money, never a member', async () => {
    await buy();
    const backup = await addCard(FAKE_CARDS.disputes);
    await expect(
      executeCommand(
        api(),
        billingSetDefaultCard,
        { workspaceId, cardId: backup },
        human(member),
        meta(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      executeQuery(api(), billingGet, { workspaceId }, human(member), meta()),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('renewing on the cards in turn', () => {
  it('falls through a declined default to a backup, and keeps the decline on the card', async () => {
    await buy(FAKE_CARDS.failsOffSession);
    const backup = await addCard(FAKE_CARDS.disputes);
    const before = s.payments.fake.platformCharges().length;
    await periodUp();
    await sweep();
    const p = await planNow();
    expect(p).toMatchObject({ status: 'active', renewal_count: 1, renewal_failed_at: null });
    const charges = s.payments.fake.platformCharges().slice(before);
    expect(charges.map((c) => [c.amountCents, c.status])).toEqual([
      [49_700, 'failed'],
      [49_700, 'succeeded'],
    ]);
    const cards = await cardsNow();
    expect(cards.find((c) => c.is_default)?.last_declined_at).not.toBeNull();
    expect(cards.find((c) => c.id === backup)?.last_declined_at).toBeNull();
  });
});

describe('a declined payment', () => {
  it('is tried again once a day, and the business sees it owes', async () => {
    await buy(FAKE_CARDS.failsOffSession);
    await periodUp();
    await sweep();
    const failed = await planNow();
    expect(failed).toMatchObject({ status: 'past_due', retry_count: 0 });
    const ahead =
      new Date(failed.next_retry_at!).getTime() - new Date(failed.renewal_failed_at!).getTime();
    expect(ahead).toBeGreaterThanOrEqual(DAY);
    expect(ahead).toBeLessThan(2 * DAY);

    // Everyone in the business is told; only whoever manages money can fix it, and is named for the others.
    const forMember = await executeQuery(
      api(),
      billingStatus,
      { workspaceId },
      human(member),
      meta(),
    );
    expect(forMember).toMatchObject({ canManage: false, askWho: 'Dana Owner' });
    expect(forMember.owed?.amountCents).toBe(49_700);
    const forOwner = await executeQuery(
      api(),
      billingStatus,
      { workspaceId },
      human(owner),
      meta(),
    );
    expect(forOwner.canManage).toBe(true);

    // Not before it's due.
    const charged = s.payments.fake.platformCharges().length;
    await sweep();
    expect(s.payments.fake.platformCharges()).toHaveLength(charged);

    // The first retry, still declined: the next is a day on.
    await retryDue();
    await sweep();
    const again = await planNow();
    expect(again).toMatchObject({ status: 'past_due', retry_count: 1 });
    expect(new Date(again.next_retry_at!).getTime()).toBeGreaterThan(
      new Date(again.retry_from!).getTime() + 2 * DAY - 1,
    );
    expect(s.payments.fake.platformCharges().length).toBe(charged + 1);

    // A good card added, and the next retry pays.
    await addCard(FAKE_CARDS.succeeds);
    await retryDue();
    await sweep();
    expect(await planNow()).toMatchObject({
      status: 'active',
      renewal_failed_at: null,
      retry_count: 0,
      next_retry_at: null,
    });
    expect(
      (await executeQuery(api(), billingStatus, { workspaceId }, human(member), meta())).owed,
    ).toBeNull();
  });

  it('is paid at once with Try my cards now', async () => {
    await buy(FAKE_CARDS.failsOffSession);
    await periodUp();
    await sweep();
    await addCard(FAKE_CARDS.succeeds, true);
    const out = await executeCommand(api(), billingPayNow, { workspaceId }, human(owner), meta());
    expect(out.output.outcome).toBe('trying');
    await drain();
    expect(await planNow()).toMatchObject({ status: 'active', renewal_count: 1 });
  });
});

describe('the payment day', () => {
  const dayOf = (iso: string, plus: number) =>
    new Date(new Date(iso).getTime() + plus * DAY).toISOString().slice(0, 10);

  it('moved later costs the days it adds, paid now, and moves once paid', async () => {
    await buy();
    const before = await planNow();
    const to = dayOf(before.current_period_end!, 10);
    const quote = await executeQuery(
      api(),
      billingPayDayQuote,
      { workspaceId, day: to },
      human(owner),
      meta(),
    );
    expect(quote).toMatchObject({ kind: 'later', days: 10, refusal: null });
    expect(quote.cents).toBe(Math.round((49_700 * 10) / 365));

    const charged = s.payments.fake.platformCharges().length;
    const out = await executeCommand(
      api(),
      billingChangePayDay,
      { workspaceId, day: to },
      human(owner),
      meta(),
    );
    expect(out.output.outcome).toBe('charging');
    await drain();
    const after = await planNow();
    expect(after.current_period_end!.slice(0, 10)).toBe(to);
    expect(
      s.payments.fake
        .platformCharges()
        .slice(charged)
        .map((c) => c.amountCents),
    ).toEqual([quote.cents]);
  });

  it('moved earlier moves at once, and takes the days given up off the next payment', async () => {
    await buy();
    const before = await planNow();
    const to = dayOf(before.current_period_end!, -10);
    const out = await executeCommand(
      api(),
      billingChangePayDay,
      { workspaceId, day: to },
      human(owner),
      meta(),
    );
    expect(out.output).toMatchObject({ outcome: 'moved', kind: 'earlier' });
    const credit = Math.round((49_700 * 10) / 365);
    const moved = await planNow();
    expect(moved.current_period_end!.slice(0, 10)).toBe(to);
    expect(moved.pay_day_credit_cents).toBe(credit);

    const charged = s.payments.fake.platformCharges().length;
    await periodUp();
    await sweep();
    expect(
      s.payments.fake
        .platformCharges()
        .slice(charged)
        .map((c) => c.amountCents),
    ).toEqual([49_700 - credit]);
    expect((await planNow()).pay_day_credit_cents).toBe(0);
  });

  it('can’t move while a payment is owed', async () => {
    await buy(FAKE_CARDS.failsOffSession);
    await periodUp();
    await sweep();
    await expect(
      executeCommand(
        api(),
        billingChangePayDay,
        { workspaceId, day: dayOf(new Date().toISOString(), 5) },
        human(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'plan_pay_day_past_due' });
  });
});

describe('more time', () => {
  it('opens a ticket, and a grant pauses the retries and the page until that day', async () => {
    await buy(FAKE_CARDS.failsOffSession);
    await periodUp();
    await sweep();
    const payBy = new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10);
    const asked = await executeCommand(
      api(),
      billingAskMoreTime,
      { workspaceId, payBy, note: 'Payday is next Friday.' },
      human(owner),
      meta(),
    );
    const [ticket] = await rows<{ subject: string; workspace_id: string }>(
      admin(),
      sql`select t.subject, t.workspace_id from platform.tickets t
          join app.plan_time_requests r on r.ticket_id = t.id where r.id = ${asked.output.requestId}::uuid`,
    );
    expect(ticket).toMatchObject({ workspace_id: workspaceId });
    expect(ticket!.subject).toContain('More time');
    // One waiting at a time.
    await expect(
      executeCommand(
        api(),
        billingAskMoreTime,
        { workspaceId, payBy, note: '' },
        human(owner),
        meta(),
      ),
    ).rejects.toMatchObject({ rule: 'plan_more_time_waiting' });

    await executeCommand(
      api(),
      billingAnswerMoreTime,
      { requestId: asked.output.requestId, grant: true },
      human(staff),
      meta(),
    );
    const granted = await planNow();
    expect(granted.more_time_until!.slice(0, 10)).toBe(payBy);
    expect(new Date(granted.next_retry_at!).getTime()).toBeGreaterThanOrEqual(
      new Date(`${payBy}T00:00:00Z`).getTime(),
    );
    const status = await executeQuery(api(), billingStatus, { workspaceId }, human(member), meta());
    expect(status.owed?.moreTimeUntil?.slice(0, 10)).toBe(payBy);
    expect(paymentBlockOf(status.owed, new Date(), null)).toBeNull();

    // Even a retry forced due doesn't charge while the time runs.
    const charged = s.payments.fake.platformCharges().length;
    await retryDue();
    await sweep();
    expect(s.payments.fake.platformCharges()).toHaveLength(charged);
  });
});
