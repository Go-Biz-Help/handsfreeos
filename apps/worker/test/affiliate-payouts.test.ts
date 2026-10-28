/**
 * Paying affiliates (20261027014400, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 4), against the payments
 * stand-in, which does what Stripe does:
 *
 * - An affiliate sets up their bank from their page, on Stripe's own form, and it's read back on their way home.
 * - Once a month, what's ready is sent from HandsFreeOS's own balance, $25 at least, once; they hear how much.
 * - A share taken back after a payout comes off the next one; less than $25 waits.
 * - A payout Stripe won't take for them is held, and sent once it can; one our balance can't cover waits.
 * - Nothing is sent while staff have payouts off.
 */
import { randomUUID } from 'node:crypto';
import { AFFILIATE_TERMS_VERSION, executeCommand, organizationCreate } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import {
  closeTestDbs,
  createTestUser,
  signInTestUser,
  testDbs,
  type TestUser,
} from '@hfos/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { planAffiliatePayouts } from '../src/affiliates/payouts';
import { buildHttpServer } from '../src/http/server';
import type { JobContext } from '../src/jobs';
import { waitForMail } from './booking-world';
import { testTokenVerifier } from './finish-sign-in';
import { testServices, type TestServices } from './helpers';

const admin = () => testDbs().admin.db;

let s: TestServices;
let app: FastifyInstance;
let seller: TestUser;
let sellerToken: string;
let sellerId: string;
/** The business whose payments the shares are of. */
let orgId: string;

const fake = () => s.payments.fake;

const call = (
  body: Record<string, unknown>,
  bearer: string | null,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method: 'POST',
    url: '/v1/affiliate/payouts',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    payload: JSON.stringify(body),
  });

const plan = () =>
  planAffiliatePayouts({
    ...s,
    job: { payload: {} },
    scope: {},
    attempt: 1,
    now: Date.now(),
  } as unknown as JobContext);

const payoutsOn = (on: boolean) =>
  admin().execute(sql`update platform.affiliate_settings set payouts_on = ${on} where id`);

/** An approved affiliate, signed up as a person of their own, who agreed to the terms that count now. */
async function newAffiliate(label: string): Promise<{ user: TestUser; id: string }> {
  const user = await createTestUser(`affiliate-payouts-${label}`, { fullName: 'Sam Seller' });
  const [a] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.affiliates (user_id, code, status, name, terms_version, terms_accepted_at)
        values (${user.id}::uuid, ${`pay-${randomUUID().slice(0, 8)}`}, 'approved', 'Sam Seller',
          ${AFFILIATE_TERMS_VERSION}, now())
        returning id`,
  );
  return { user, id: a!.id };
}

/** A share earned on a payment of this much, free to pay out `days` from now (negative: already free). */
async function share(affiliateId: string, cents: number, days: number, kind = 'earned') {
  const [p] = await rows<{ id: string }>(
    admin(),
    sql`insert into platform.plan_payments (organization_id, how, payment_ref, amount_cents, period_from, paid_at)
        values (${orgId}, 'checkout', ${`pi_aff_${randomUUID()}`}, 9700, now(), now()) returning id`,
  );
  let refund: string | null = null;
  if (kind !== 'earned') {
    const [r] = await rows<{ id: string }>(
      admin(),
      sql`insert into platform.plan_refunds (payment_id, refund_ref, amount_cents, status, refunded_at)
          values (${p!.id}, ${`re_aff_${randomUUID()}`}, 9700, 'succeeded', now()) returning id`,
    );
    refund = r!.id;
  }
  await admin().execute(
    sql`insert into platform.affiliate_commissions
          (affiliate_id, organization_id, payment_id, refund_id, kind, base_cents, rate_bp, amount_cents, earned_at,
           payable_at)
        values (${affiliateId}, ${orgId}, ${p!.id}, ${refund}, ${kind}, 9700, 4000, ${cents}, now(),
          now() + make_interval(days => ${days}))`,
  );
}

const payouts = (affiliateId: string) =>
  rows<{
    id: string;
    amount_cents: number;
    status: string;
    transfer_ref: string | null;
    month: string;
  }>(
    admin(),
    sql`select id, amount_cents, status, transfer_ref, month::text as month from platform.affiliate_payouts
        where affiliate_id = ${affiliateId} order by created_at`,
  );

/** Their bank, set up through their page and finished on Stripe's form. */
async function bankReady(user: TestUser, ready = true): Promise<string> {
  const token = await signInTestUser(user);
  const started = await call({ action: 'start' }, token);
  expect(started.statusCode).toBe(200);
  const accountRef = new URL(started.json<{ url: string }>().url).searchParams.get('account')!;
  await fake().finishPayoutAccount(accountRef, { ready });
  expect((await call({ action: 'check' }, token)).json()).toEqual({ ready });
  return accountRef;
}

beforeAll(async () => {
  s = testServices();
  app = await buildHttpServer({
    ...s,
    httpDb: testDbs().worker.db,
    verifyToken: testTokenVerifier(),
    webOrigins: ['http://localhost:3000'],
  });
  const owner = await createTestUser('affiliate-payouts-owner');
  const { output } = await executeCommand(
    testDbs().api.db,
    organizationCreate,
    { businessName: 'Payout Plumbing' },
    { type: 'human', userId: owner.id, email: owner.email, claims: owner.claims },
    { correlationId: randomUUID(), channel: 'test' },
  );
  orgId = output.organizationId;
  ({ user: seller, id: sellerId } = await newAffiliate('seller'));
  sellerToken = await signInTestUser(seller);
});

afterAll(async () => {
  await payoutsOn(false);
  await app?.close();
  await closeTestDbs();
});

beforeEach(async () => {
  await payoutsOn(true);
  fake().setBalanceShort(false);
});

describe('setting up their bank', () => {
  it('opens Stripe’s own form, makes one account however often they press, and reads it back on their way home', async () => {
    const before = await call({ action: 'stripe' }, sellerToken);
    expect(before.statusCode).toBe(409);
    expect(before.json()).toMatchObject({ error: { rule: 'affiliate_payouts_not_set_up' } });

    const started = await call({ action: 'start' }, sellerToken);
    expect(started.statusCode).toBe(200);
    const page = new URL(started.json<{ url: string }>().url);
    expect(page.pathname).toBe('/payments/fake/express');
    expect(page.searchParams.get('return')).toBe('http://localhost:3000/affiliate?payouts=back');
    const accountRef = page.searchParams.get('account')!;
    expect((await call({ action: 'start' }, sellerToken)).json<{ url: string }>().url).toContain(
      accountRef,
    );
    const [kept] = await rows<{ account_ref: string; details_submitted: boolean }>(
      admin(),
      sql`select account_ref, details_submitted from platform.affiliate_payout_accounts
          where affiliate_id = ${sellerId}`,
    );
    expect(kept).toEqual({ account_ref: accountRef, details_submitted: false });
    expect((await call({ action: 'check' }, sellerToken)).json()).toEqual({ ready: false });

    await fake().finishPayoutAccount(accountRef);
    expect((await call({ action: 'check' }, sellerToken)).json()).toEqual({ ready: true });
    const stripe = await call({ action: 'stripe' }, sellerToken);
    expect(stripe.json<{ url: string }>().url).toContain('dashboard=1');
  });

  it('is only for approved affiliates, signed in, who agreed to the terms that count now', async () => {
    expect((await call({ action: 'start' }, null)).statusCode).toBe(401);
    const stranger = await createTestUser('affiliate-payouts-stranger');
    const refused = await call({ action: 'start' }, await signInTestUser(stranger));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { rule: 'affiliate_not_approved' } });

    const { user, id } = await newAffiliate('old-terms');
    await admin().execute(
      sql`update platform.affiliates set terms_version = '2026-01-01' where id = ${id}`,
    );
    const token = await signInTestUser(user);
    const old = await call({ action: 'start' }, token);
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ error: { rule: 'affiliate_terms_needed' } });
    expect(
      await rows(
        admin(),
        sql`select 1 from platform.affiliate_payout_accounts where affiliate_id = ${id}`,
      ),
    ).toEqual([]);
  });
});

describe('the monthly payout', () => {
  it('sends what’s ready once a month, from our own balance, and tells them', async () => {
    const { user, id } = await newAffiliate('monthly');
    const accountRef = await bankReady(user);
    await share(id, 3880, -1);
    await share(id, 1000, 20);
    const sentBefore = fake().transfers().length;
    await plan();
    const [paid] = await payouts(id);
    expect(paid).toMatchObject({ amount_cents: 3880, status: 'paid' });
    const sent = fake().transfers().slice(sentBefore);
    expect(sent).toEqual([
      expect.objectContaining({
        id: paid!.transfer_ref,
        accountRef,
        amountCents: 3880,
        sourceChargeRef: null,
      }),
    ]);
    // Only the share that was ready is on it.
    const [tied] = await rows<{ on_it: number; waiting: number }>(
      admin(),
      sql`select count(*) filter (where payout_id = ${paid!.id})::int as on_it,
            count(*) filter (where payout_id is null)::int as waiting
          from platform.affiliate_commissions where affiliate_id = ${id}`,
    );
    expect(tied).toEqual({ on_it: 1, waiting: 1 });
    const mail = await waitForMail(user.email, 'Your HandsFreeOS affiliate payout: $38.80');
    expect(mail.text).toContain('your');
    expect(mail.text).toContain('http://localhost:3000/affiliate');

    // Again this month: nothing more.
    await plan();
    expect(await payouts(id)).toHaveLength(1);
    expect(fake().transfers().slice(sentBefore)).toHaveLength(1);
  });

  it('takes a share taken back after a payout off the next one, and less than $25 waits', async () => {
    const { user, id } = await newAffiliate('next');
    await bankReady(user);
    await share(id, 3000, -1);
    await plan();
    expect((await payouts(id)).map((p) => p.amount_cents)).toEqual([3000]);
    // That one was last month's, as far as this month is concerned.
    await admin().execute(
      sql`update platform.affiliate_payouts set month = (month - interval '1 month')::date
          where affiliate_id = ${id}`,
    );

    // A share it paid is taken back, and a new one earned: $20 owed, so it waits.
    await share(id, -1000, -1, 'taken_back');
    await share(id, 3000, -1);
    await plan();
    expect(await payouts(id)).toHaveLength(1);

    // Another comes free: $28 owed, sent with the share taken back off it.
    await share(id, 800, -1);
    await plan();
    expect((await payouts(id)).map((p) => [p.amount_cents, p.status])).toEqual([
      [3000, 'paid'],
      [2800, 'paid'],
    ]);
    const [left] = await rows<{ n: number }>(
      admin(),
      sql`select count(*)::int as n from platform.affiliate_commissions
          where affiliate_id = ${id} and payout_id is null`,
    );
    expect(left!.n).toBe(0);
  });

  it('holds a payout Stripe won’t take for them, and sends it once their account can', async () => {
    const { user, id } = await newAffiliate('held');
    const accountRef = await bankReady(user);
    await share(id, 5000, -1);
    // Stripe stops their account before the payout goes, and we haven't heard yet.
    await fake().finishPayoutAccount(accountRef, { ready: false });
    await plan();
    expect((await payouts(id)).map((p) => p.status)).toEqual(['held']);
    await fake().finishPayoutAccount(accountRef, { ready: true });
    await plan();
    expect((await payouts(id)).map((p) => [p.amount_cents, p.status])).toEqual([[5000, 'paid']]);
  });

  it('builds nothing for a bank that isn’t set up, while staff have payouts off, and waits on a short balance', async () => {
    const { user, id } = await newAffiliate('waits');
    await share(id, 5000, -1);
    await plan();
    expect(await payouts(id)).toEqual([]);

    await bankReady(user);
    await payoutsOn(false);
    await plan();
    expect(await payouts(id)).toEqual([]);

    await payoutsOn(true);
    fake().setBalanceShort(true);
    await plan();
    expect((await payouts(id)).map((p) => p.status)).toEqual(['sending']);
    fake().setBalanceShort(false);
    await plan();
    expect((await payouts(id)).map((p) => p.status)).toEqual(['paid']);
  });
});
