/**
 * The affiliate program, part 1 (20261027014000), through the command pipeline: applying, staff deciding and setting
 * shares, and a business made through an affiliate's link being credited to them as it's made, and only then. And
 * part 2's reading (20261027014200): what they've earned, on their own page and staff's. The earning itself is
 * apps/worker/test/founding-checkout.test.ts, where the payments happen. And part 3's codes (20261027014300): making
 * and turning them, the limit, house codes, and what the plan page shows and buys with one. Paying with one, and the
 * trial, are in the worker's test too.
 */
import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, createTestUser, testDbs, type TestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { HfosError } from '../src/errors';
import { executeCommand, executeQuery } from '../src/kernel/execute';
import type { CommandDef, HumanActor, QueryDef, RequestMeta } from '../src/kernel/types';
import {
  affiliateApply,
  affiliateDecide,
  affiliateMakeCode,
  affiliateMine,
  affiliateSetBusiness,
  affiliateSetCode,
  affiliateSetMaxDiscount,
  affiliateSetRate,
  affiliateSetStatus,
  affiliatesMakeCode,
  affiliatesSaveSettings,
  affiliatesTurnCode,
  affiliateTurnCode,
  foundingBuy,
  foundingCodePreview,
  organizationCreate,
  platformAffiliate,
  platformAffiliateOfBusiness,
  platformAffiliates,
} from '../src/server';

const api = () => testDbs().api.db;
const admin = () => testDbs().admin.db;
const human = (u: TestUser): HumanActor => ({
  type: 'human',
  userId: u.id,
  email: u.email,
  claims: u.claims,
});
const meta = (): RequestMeta => ({ correlationId: randomUUID(), channel: 'test' });
const run = <I extends z.ZodType, O extends z.ZodType>(
  cmd: CommandDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeCommand(api(), cmd, input, human(u), meta()).then((r) => r.output);
const ask = <I extends z.ZodType, O extends z.ZodType>(
  q: QueryDef<I, O>,
  input: unknown,
  u: TestUser,
) => executeQuery(api(), q, input, human(u), meta());

async function refusal(fn: () => Promise<unknown>): Promise<HfosError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HfosError);
    return e as HfosError;
  }
  throw new Error('expected a refusal, but the call succeeded');
}

const suffix = randomUUID().slice(0, 6);
const codeFor = (who: string) => `${who}-${suffix}`;

let dana: TestUser;
let riley: TestUser;
let buyer: TestUser;
let staff: TestUser;
let agent: TestUser;

beforeAll(async () => {
  [dana, riley, buyer, staff, agent] = await Promise.all([
    createTestUser('affiliate-dana', { fullName: 'Dana Seller' }),
    createTestUser('affiliate-riley', { fullName: 'Riley Seller' }),
    createTestUser('affiliate-buyer', { fullName: 'Bo Buyer' }),
    createTestUser('affiliate-staff'),
    createTestUser('affiliate-agent'),
  ]);
  await admin().execute(
    sql`insert into platform.staff (user_id, role) values (${staff.id}, 'admin'), (${agent.id}, 'agent')
        on conflict (user_id) do update set role = excluded.role, status = 'active'`,
  );
});

afterAll(async () => {
  await admin().execute(
    sql`update platform.affiliate_settings set rate_bp = 4000, max_discount_bp = 5000 where id`,
  );
  await closeTestDbs();
});

beforeEach(async () => {
  await admin().execute(
    sql`delete from platform.affiliates where user_id in (${dana.id}, ${riley.id}, ${buyer.id})`,
  );
});

const apply = (u: TestUser, code: string, extra: Record<string, unknown> = {}) =>
  run(
    affiliateApply,
    { name: 'Dana Seller', code, pitch: 'My podcast', links: '', livesInUs: true, ...extra },
    u,
  );

async function approved(u: TestUser, code: string): Promise<string> {
  const { affiliateId } = await apply(u, code);
  await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);
  return affiliateId;
}

describe('applying', () => {
  it('keeps what they said, lowercases the code, and shows it on their own page', async () => {
    const code = codeFor('Dana');
    const out = await apply(dana, code);
    expect(out.created).toBe(true);
    const { affiliate, defaultRateBp } = await ask(affiliateMine, {}, dana);
    expect(affiliate).toMatchObject({
      status: 'applied',
      code: code.toLowerCase(),
      pitch: 'My podcast',
      rateBp: defaultRateBp,
      clicks30: 0,
    });
    // Nobody else's page shows it.
    expect((await ask(affiliateMine, {}, riley)).affiliate).toBeNull();
  });

  it('changes the application while it waits, and refuses once decided', async () => {
    const { affiliateId } = await apply(dana, codeFor('dana'));
    const again = await apply(dana, codeFor('dana2'), { pitch: 'Videos too' });
    expect(again).toEqual({ affiliateId, created: false });
    await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);
    const e = await refusal(() => apply(dana, codeFor('dana3')));
    expect(e.rule).toBe('affiliate_already');
  });

  it('refuses outside the US, a kept word, and a code somebody else has', async () => {
    expect((await refusal(() => apply(dana, codeFor('d'), { livesInUs: false }))).rule).toBe(
      'affiliate_outside_us',
    );
    expect((await refusal(() => apply(dana, 'support'))).code).toBe('validation');
    await apply(dana, codeFor('taken'));
    expect((await refusal(() => apply(riley, codeFor('TAKEN')))).rule).toBe('affiliate_code_taken');
  });

  it('a turned-down person waits 30 days to apply again', async () => {
    const { affiliateId } = await apply(dana, codeFor('no'));
    await run(affiliateDecide, { affiliateId, decision: 'turn_down' }, staff);
    const mine = (await ask(affiliateMine, {}, dana)).affiliate!;
    expect(mine.status).toBe('turned_down');
    expect(Date.parse(mine.applyAgainFrom!)).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect((await refusal(() => apply(dana, codeFor('no')))).rule).toBe(
      'affiliate_turned_down_recently',
    );
    await admin().execute(
      sql`update platform.affiliates set decided_at = now() - interval '31 days' where id = ${affiliateId}`,
    );
    expect(await apply(dana, codeFor('no'))).toEqual({ affiliateId, created: false });
    expect((await ask(affiliateMine, {}, dana)).affiliate?.status).toBe('applied');
  });
});

describe('staff', () => {
  it('only support admins see and run the program', async () => {
    const { affiliateId } = await apply(dana, codeFor('staffonly'));
    for (const u of [agent, riley]) {
      // Somebody who isn't staff is told there's nothing here at all, as the admin side always answers them.
      const e = await refusal(() => run(affiliateDecide, { affiliateId, decision: 'approve' }, u));
      expect(['forbidden', 'not_found']).toContain(e.code);
      const q = await refusal(() => ask(platformAffiliates, {}, u));
      expect(['forbidden', 'not_found']).toContain(q.code);
    }
  });

  it('decide, pause, bring back, end; the list and one affiliate’s page say so', async () => {
    const { affiliateId } = await apply(dana, codeFor('flow'));
    let list = await ask(platformAffiliates, {}, staff);
    expect(list.applications.map((a) => a.affiliateId)).toContain(affiliateId);

    const decided = await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);
    expect(decided.affiliate).toMatchObject({ status: 'approved', email: dana.email });
    expect(
      (await refusal(() => run(affiliateDecide, { affiliateId, decision: 'approve' }, staff))).rule,
    ).toBe('affiliate_already_decided');

    list = await ask(platformAffiliates, {}, staff);
    expect(list.affiliates.map((a) => a.affiliateId)).toContain(affiliateId);

    await run(affiliateSetStatus, { affiliateId, status: 'paused' }, staff);
    await run(affiliateSetStatus, { affiliateId, status: 'approved' }, staff);
    await run(affiliateSetStatus, { affiliateId, status: 'ended' }, staff);
    const e = await refusal(() =>
      run(affiliateSetStatus, { affiliateId, status: 'approved' }, staff),
    );
    expect(e.rule).toBe('affiliate_ended');

    const page = await ask(platformAffiliate, { affiliateId }, staff);
    expect(page.affiliate.status).toBe('ended');
  });

  it('the share for everyone, and one affiliate’s own', async () => {
    const affiliateId = await approved(dana, codeFor('rate'));
    await run(affiliatesSaveSettings, { rateBp: 3500 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.rateBp).toBe(3500);
    await run(affiliateSetRate, { affiliateId, rateBp: 5000 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.rateBp).toBe(5000);
    await run(affiliateSetRate, { affiliateId, rateBp: null }, staff);
    const mine = await ask(affiliateMine, {}, dana);
    expect(mine.affiliate?.rateBp).toBe(3500);
    expect(mine.defaultRateBp).toBe(3500);
    await run(affiliatesSaveSettings, { rateBp: 4000 }, staff);
  });

  it('changes a link code, never to one somebody has', async () => {
    const affiliateId = await approved(dana, codeFor('old'));
    await apply(riley, codeFor('riley'));
    await run(affiliateSetCode, { affiliateId, code: codeFor('new') }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.code).toBe(codeFor('new'));
    expect(
      (await refusal(() => run(affiliateSetCode, { affiliateId, code: codeFor('riley') }, staff)))
        .rule,
    ).toBe('affiliate_code_taken');
  });
});

describe('a business made through a link', () => {
  const make = (u: TestUser, affiliate?: Record<string, unknown>) =>
    run(
      organizationCreate,
      { businessName: `Ref Plumbing ${randomUUID().slice(0, 4)}`, affiliate },
      u,
    );

  const creditedTo = async (orgId: string) =>
    (
      await rows<{ affiliate_id: string; how: string }>(
        admin(),
        sql`select affiliate_id, how from platform.affiliate_referrals where organization_id = ${orgId}`,
      )
    )[0] ?? null;

  it('is credited to an approved affiliate as it’s made', async () => {
    const affiliateId = await approved(dana, codeFor('link'));
    const clickedAt = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const org = await make(buyer, { code: codeFor('LINK'), clickedAt });
    expect(await creditedTo(org.organizationId)).toEqual({
      affiliate_id: affiliateId,
      how: 'link',
    });
    const page = await ask(platformAffiliate, { affiliateId }, staff);
    expect(page.businesses).toEqual([
      expect.objectContaining({ organizationId: org.organizationId, how: 'link', clickedAt }),
    ]);
    expect(page.affiliate.businesses).toBe(1);
  });

  it('with no code, uses the link the account was made through, for its first business only', async () => {
    const affiliateId = await approved(dana, codeFor('kept'));
    const fresh = await createTestUser('affiliate-fresh');
    const clickedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    await admin().execute(
      sql`update auth.users set raw_user_meta_data = raw_user_meta_data
            || jsonb_build_object('affiliate_ref', ${codeFor('kept')}::text, 'affiliate_ref_at', ${clickedAt}::text)
          where id = ${fresh.id}`,
    );
    const first = await make(fresh);
    expect(await creditedTo(first.organizationId)).toEqual({
      affiliate_id: affiliateId,
      how: 'link',
    });
    expect(await creditedTo((await make(fresh)).organizationId)).toBeNull();

    // A link kept from a click too long ago counts for nothing.
    const late = await createTestUser('affiliate-late');
    await admin().execute(
      sql`update auth.users set raw_user_meta_data = raw_user_meta_data
            || jsonb_build_object('affiliate_ref', ${codeFor('kept')}::text,
                 'affiliate_ref_at', ${new Date(Date.now() - 91 * 86_400_000).toISOString()}::text)
          where id = ${late.id}`,
    );
    expect(await creditedTo((await make(late)).organizationId)).toBeNull();
  });

  it('is never credited to the person’s own link, an affiliate not approved, an old click or a made-up code', async () => {
    await approved(dana, codeFor('self'));
    expect(
      await creditedTo((await make(dana, { code: codeFor('self') })).organizationId),
    ).toBeNull();

    await apply(riley, codeFor('waiting'));
    expect(
      await creditedTo((await make(buyer, { code: codeFor('waiting') })).organizationId),
    ).toBeNull();

    const old = new Date(Date.now() - 91 * 86_400_000).toISOString();
    expect(
      await creditedTo(
        (await make(buyer, { code: codeFor('self'), clickedAt: old })).organizationId,
      ),
    ).toBeNull();

    expect(
      await creditedTo((await make(buyer, { code: 'nobody-at-all' })).organizationId),
    ).toBeNull();
  });

  it('a paused affiliate’s link credits nobody', async () => {
    const affiliateId = await approved(dana, codeFor('paused'));
    await run(affiliateSetStatus, { affiliateId, status: 'paused' }, staff);
    expect(
      await creditedTo((await make(buyer, { code: codeFor('paused') })).organizationId),
    ).toBeNull();
  });

  it('staff credit a business by hand, move it, and take it off; never to its own maker', async () => {
    const danaId = await approved(dana, codeFor('hand'));
    const rileyId = await approved(riley, codeFor('hand2'));
    const org = await make(buyer);
    const before = await ask(platformAffiliateOfBusiness, { workspaceId: org.workspaceId }, staff);
    expect(before.affiliate).toBeNull();
    expect(before.choices.map((c) => c.affiliateId)).toEqual(
      expect.arrayContaining([danaId, rileyId]),
    );

    const set = await run(
      affiliateSetBusiness,
      { workspaceId: org.workspaceId, affiliateId: danaId },
      staff,
    );
    expect(set.affiliate).toMatchObject({ affiliateId: danaId, how: 'by_hand' });
    await run(affiliateSetBusiness, { workspaceId: org.workspaceId, affiliateId: rileyId }, staff);
    expect((await creditedTo(org.organizationId))?.affiliate_id).toBe(rileyId);
    const off = await run(
      affiliateSetBusiness,
      { workspaceId: org.workspaceId, affiliateId: null },
      staff,
    );
    expect(off.affiliate).toBeNull();

    const own = await make(dana);
    const e = await refusal(() =>
      run(affiliateSetBusiness, { workspaceId: own.workspaceId, affiliateId: danaId }, staff),
    );
    expect(e.rule).toBe('affiliate_own_business');
  });
});

describe('clicks', () => {
  it('count an approved affiliate’s link only, and show on their page', async () => {
    const code = codeFor('clicks');
    await apply(dana, code);
    const click = () =>
      rows<{ counted: boolean }>(admin(), sql`select private.affiliate_click(${code}) as counted`);
    expect((await click())[0]!.counted).toBe(false);
    const { affiliate } = await ask(affiliateMine, {}, dana);
    await run(affiliateDecide, { affiliateId: affiliate!.affiliateId, decision: 'approve' }, staff);
    await click();
    await click();
    const mine = await ask(affiliateMine, {}, dana);
    expect(mine.affiliate).toMatchObject({ clicks30: 2, clicksAll: 2 });
  });
});

describe('what they earn', () => {
  it('shows on their own page and staff’s: sign-ups, paying businesses by name, earned, waiting and ready', async () => {
    const affiliateId = await approved(dana, codeFor('earn'));
    const made = () =>
      run(
        organizationCreate,
        {
          businessName: `Paying Plumbing ${randomUUID().slice(0, 4)}`,
          affiliate: { code: codeFor('earn') },
        },
        buyer,
      );
    const paying = await made();
    await made();
    const pay = async (cents: number, daysAgo: number) => {
      const [p] = await rows<{ id: string }>(
        admin(),
        sql`insert into platform.plan_payments
              (organization_id, workspace_id, how, payment_ref, amount_cents, period_from, paid_at)
            values (${paying.organizationId}, ${paying.workspaceId}, 'checkout', ${`pi_${randomUUID()}`},
              ${cents}, now() - make_interval(days => ${daysAgo}), now() - make_interval(days => ${daysAgo}))
            returning id`,
      );
      return p!.id;
    };
    const commission = (paymentId: string, kind: string, cents: number, payableDays: number) =>
      admin().execute(
        sql`insert into platform.affiliate_commissions
              (affiliate_id, organization_id, payment_id, refund_id, kind, base_cents, rate_bp, amount_cents,
               earned_at, payable_at)
            values (${affiliateId}, ${paying.organizationId}, ${paymentId},
              ${kind === 'earned' ? null : sql`(select id from platform.plan_refunds where payment_id = ${paymentId})`},
              ${kind}, 9700, 4000, ${cents}, now(), now() + make_interval(days => ${payableDays}))`,
      );
    // Paid 40 days ago, so ready; paid today, so waiting; then part of today's refunded.
    const old = await pay(9700, 40);
    await commission(old, 'earned', 3880, -10);
    const fresh = await pay(9700, 0);
    await commission(fresh, 'earned', 3880, 30);
    await admin().execute(
      sql`insert into platform.plan_refunds (payment_id, refund_ref, amount_cents, status, refunded_at)
          values (${fresh}, ${`re_${randomUUID()}`}, 2500, 'succeeded', now())`,
    );
    await commission(fresh, 'taken_back', -1000, 30);

    const mine = (await ask(affiliateMine, {}, dana)).affiliate!;
    expect(mine.signUps).toBe(2);
    expect(mine.payingBusinesses).toEqual([
      expect.objectContaining({
        name: expect.stringContaining('Paying Plumbing'),
        earnedCents: 6760,
      }),
    ]);
    expect(mine.earnings).toEqual({
      earnedCents: 6760,
      waitingCents: 2880,
      readyCents: 3880,
      paidCents: 0,
    });
    // Somebody else's page shows none of it.
    await apply(riley, codeFor('none'));
    const theirs = (await ask(affiliateMine, {}, riley)).affiliate!;
    expect(theirs).toMatchObject({ signUps: 0, payingBusinesses: [] });
    expect(theirs.earnings.earnedCents).toBe(0);

    const page = await ask(platformAffiliate, { affiliateId }, staff);
    expect(page.affiliate.earnedCents).toBe(6760);
    expect(page.earnings).toEqual(mine.earnings);
    expect(page.commissions.map((c) => [c.kind, c.amountCents])).toEqual(
      expect.arrayContaining([
        ['earned', 3880],
        ['earned', 3880],
        ['taken_back', -1000],
      ]),
    );
    expect(
      page.businesses.find((b) => b.organizationId === paying.organizationId)?.earnedCents,
    ).toBe(6760);
  });
});

describe('codes', () => {
  // Off sale but not in draft, so codes are made for them and no business made here is asked to pay; the plan page's
  // test puts the monthly one on sale while it runs.
  const MONTHLY = 'test_code_monthly';
  const ONCE = 'test_code_once';
  const terms = (code: string, extra: Record<string, unknown> = {}) => ({
    code,
    offerId: null,
    percentOffBp: 2000,
    amountOffCents: null,
    discountMonths: 3,
    trialDays: null,
    ...extra,
  });

  beforeAll(async () => {
    await admin().execute(
      sql`insert into platform.founding_offers
            (id, name, seat_cap, price_cents, status, billing, paid_yearly, starting_credit_cents, show_counter, sort)
          values (${MONTHLY}, 'Code monthly', 5, 9700, 'closed', 'monthly', false, 0, true, 971),
                 (${ONCE}, 'Code once', 5, 49700, 'closed', 'once', false, 0, true, 972)
          on conflict (id) do update set status = 'closed', price_cents = excluded.price_cents`,
    );
  });

  afterAll(async () => {
    for (const offer of [MONTHLY, ONCE]) {
      await admin().execute(sql`delete from platform.founding_checkouts where offer_id = ${offer}`);
      await admin().execute(
        sql`delete from app.workspace_plans where grant_id in
              (select id from platform.founding_grants where offer_id = ${offer})`,
      );
      await admin().execute(sql`delete from platform.founding_grants where offer_id = ${offer}`);
    }
    await admin().execute(
      sql`delete from platform.affiliate_codes where code like ${`%-${suffix}`}`,
    );
    await admin().execute(
      sql`delete from platform.founding_offers where id in (${MONTHLY}, ${ONCE})`,
    );
  });

  it('only an approved affiliate makes one, and it shows on their own page with the plans it can be for', async () => {
    expect((await refusal(() => run(affiliateMakeCode, terms(codeFor('c1')), riley))).rule).toBe(
      'affiliate_not_approved',
    );
    const { affiliateId } = await apply(dana, codeFor('maker'));
    expect((await refusal(() => run(affiliateMakeCode, terms(codeFor('c1')), dana))).rule).toBe(
      'affiliate_not_approved',
    );
    await run(affiliateDecide, { affiliateId, decision: 'approve' }, staff);

    const made = await run(affiliateMakeCode, terms(codeFor('C1').toUpperCase()), dana);
    expect(made.code).toMatchObject({
      affiliateId,
      code: codeFor('c1').toLowerCase(),
      percentOffBp: 2000,
      discountMonths: 3,
      status: 'on',
      offByStaff: false,
      paidUses: 0,
    });
    const mine = await ask(affiliateMine, {}, dana);
    expect(mine.affiliate?.codes.map((c) => c.codeId)).toEqual([made.code.codeId]);
    expect(mine.affiliate?.maxDiscountBp).toBe(5000);
    expect(mine.plans.map((p) => p.offerId)).toEqual(expect.arrayContaining([MONTHLY, ONCE]));
    // Nobody else's page shows it; staff's does.
    await apply(riley, codeFor('r'));
    expect((await ask(affiliateMine, {}, riley)).affiliate?.codes).toEqual([]);
    const page = await ask(platformAffiliate, { affiliateId }, staff);
    expect(page.codes.map((c) => c.code)).toEqual([made.code.code]);
  });

  it('refuses a code somebody has, more off than the limit, a trial on a plan paid once, and both kinds at once', async () => {
    await approved(dana, codeFor('limits'));
    await run(affiliateMakeCode, terms(codeFor('mine')), dana);
    await approved(riley, codeFor('limits2'));
    expect((await refusal(() => run(affiliateMakeCode, terms(codeFor('mine')), riley))).rule).toBe(
      'affiliate_code_taken',
    );
    const over = await refusal(() =>
      run(affiliateMakeCode, terms(codeFor('big'), { percentOffBp: 6000 }), dana),
    );
    expect(over.rule).toBe('affiliate_code_over_limit');
    expect(over.message).toContain('50%');
    // Dollars: half the cheapest plan it's for.
    const dollars = await refusal(() =>
      run(
        affiliateMakeCode,
        terms(codeFor('bigd'), { offerId: MONTHLY, percentOffBp: null, amountOffCents: 5000 }),
        dana,
      ),
    );
    expect(dollars.rule).toBe('affiliate_code_over_limit');
    expect(dollars.message).toContain('$48.50');
    expect(
      (
        await refusal(() =>
          run(
            affiliateMakeCode,
            terms(codeFor('trial'), { offerId: ONCE, percentOffBp: null, trialDays: 14 }),
            dana,
          ),
        )
      ).rule,
    ).toBe('affiliate_code_no_plan');
    expect(
      (
        await refusal(() =>
          run(affiliateMakeCode, terms(codeFor('both'), { amountOffCents: 500 }), dana),
        )
      ).code,
    ).toBe('validation');
  });

  it('staff turn a code off, and only staff turn it back on', async () => {
    await approved(dana, codeFor('turn'));
    const { code } = await run(affiliateMakeCode, terms(codeFor('turnme')), dana);
    const off = await run(affiliateTurnCode, { codeId: code.codeId, on: false }, dana);
    expect(off.code).toMatchObject({ status: 'off', offByStaff: false });
    await run(affiliateTurnCode, { codeId: code.codeId, on: true }, dana);

    const byStaff = await run(affiliatesTurnCode, { codeId: code.codeId, on: false }, staff);
    expect(byStaff.code).toMatchObject({ status: 'off', offByStaff: true });
    expect(
      (await refusal(() => run(affiliateTurnCode, { codeId: code.codeId, on: true }, dana))).rule,
    ).toBe('affiliate_code_off_by_staff');
    // Somebody else's code isn't there for them.
    await apply(riley, codeFor('nosy'));
    expect(
      (await refusal(() => run(affiliateTurnCode, { codeId: code.codeId, on: false }, riley))).code,
    ).toBe('not_found');
    const back = await run(affiliatesTurnCode, { codeId: code.codeId, on: true }, staff);
    expect(back.code).toMatchObject({ status: 'on', offByStaff: false });
  });

  it('the limit for everyone, and one affiliate’s own', async () => {
    const affiliateId = await approved(dana, codeFor('cap'));
    await run(affiliatesSaveSettings, { rateBp: 4000, maxDiscountBp: 3000 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.maxDiscountBp).toBe(3000);
    expect(
      (
        await refusal(() =>
          run(affiliateMakeCode, terms(codeFor('cap1'), { percentOffBp: 3500 }), dana),
        )
      ).rule,
    ).toBe('affiliate_code_over_limit');
    // The share is kept when only the limit changes.
    await run(affiliatesSaveSettings, { rateBp: 4000 }, staff);
    expect((await ask(platformAffiliates, {}, staff)).settings).toMatchObject({
      rateBp: 4000,
      maxDiscountBp: 3000,
    });

    await run(affiliateSetMaxDiscount, { affiliateId, maxDiscountBp: 4000 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.maxDiscountBp).toBe(4000);
    await run(affiliateMakeCode, terms(codeFor('cap2'), { percentOffBp: 3500 }), dana);
    await run(affiliateSetMaxDiscount, { affiliateId, maxDiscountBp: null }, staff);
    await run(affiliatesSaveSettings, { rateBp: 4000, maxDiscountBp: 5000 }, staff);
    expect((await ask(affiliateMine, {}, dana)).affiliate?.maxDiscountBp).toBe(5000);
  });

  it('staff make house codes, up to 90% off, that belong to nobody', async () => {
    const house = await run(
      affiliatesMakeCode,
      {
        affiliateId: null,
        ...terms(codeFor('house'), { percentOffBp: 9000, discountMonths: null }),
      },
      staff,
    );
    expect(house.code).toMatchObject({ affiliateId: null, percentOffBp: 9000 });
    const list = await ask(platformAffiliates, {}, staff);
    expect(list.houseCodes.map((c) => c.codeId)).toContain(house.code.codeId);
    // Nobody but staff makes one.
    await approved(dana, codeFor('nohouse'));
    const e = await refusal(() =>
      run(affiliatesMakeCode, { affiliateId: null, ...terms(codeFor('h2')) }, dana),
    );
    expect(['forbidden', 'not_found']).toContain(e.code);
  });

  describe('on the plan page', () => {
    beforeAll(async () => {
      await admin().execute(
        sql`update platform.founding_offers set status = 'open' where id = ${MONTHLY}`,
      );
    });
    afterAll(async () => {
      await admin().execute(
        sql`update platform.founding_offers set status = 'closed' where id = ${MONTHLY}`,
      );
    });

    const business = () =>
      run(organizationCreate, { businessName: `Code Plumbing ${randomUUID().slice(0, 4)}` }, buyer);
    const page = async (checkoutId: string) =>
      (
        await rows<{
          status: string;
          amount_cents: number;
          full_cents: number | null;
          discount_cents: number;
          discount_months: number | null;
          trial_days: number | null;
          code_id: string | null;
          problem: string;
        }>(
          admin(),
          sql`select status, amount_cents, full_cents, discount_cents, discount_months, trial_days, code_id, problem
              from platform.founding_checkouts where id = ${checkoutId}`,
        )
      )[0]!;

    it('shows what a code takes off each plan, and refuses one that isn’t one, is off, or is their own', async () => {
      await approved(dana, codeFor('page'));
      const off20 = (await run(affiliateMakeCode, terms(codeFor('off20')), dana)).code;
      const trial = (
        await run(
          affiliateMakeCode,
          terms(codeFor('try14'), { percentOffBp: null, discountMonths: null, trialDays: 14 }),
          dana,
        )
      ).code;
      const { workspaceId } = await business();

      const seen = await ask(
        foundingCodePreview,
        { workspaceId, code: ` ${off20.code.toUpperCase()} ` },
        buyer,
      );
      expect(seen.code).toBe(off20.code);
      expect(seen.offers.find((o) => o.offerId === MONTHLY)).toEqual({
        offerId: MONTHLY,
        applies: true,
        fullCents: 9700,
        discountCents: 1940,
        discountMonths: 3,
        trialDays: null,
      });
      const trialSeen = await ask(foundingCodePreview, { workspaceId, code: trial.code }, buyer);
      expect(trialSeen.offers.find((o) => o.offerId === MONTHLY)).toMatchObject({
        applies: true,
        discountCents: 0,
        trialDays: 14,
      });
      // A trial is for a plan paid by the month or the year.
      expect(trialSeen.offers.find((o) => o.offerId === ONCE)?.applies).toBe(false);

      expect(
        (
          await refusal(() =>
            ask(foundingCodePreview, { workspaceId, code: 'nobody-has-this' }, buyer),
          )
        ).rule,
      ).toBe('affiliate_code_unknown');
      await run(affiliatesTurnCode, { codeId: trial.codeId, on: false }, staff);
      expect(
        (await refusal(() => ask(foundingCodePreview, { workspaceId, code: trial.code }, buyer)))
          .rule,
      ).toBe('affiliate_code_unknown');

      // The affiliate's own business never uses their code.
      const own = await run(organizationCreate, { businessName: 'Dana’s Own Plumbing' }, dana);
      expect(
        (
          await refusal(() =>
            ask(foundingCodePreview, { workspaceId: own.workspaceId, code: off20.code }, dana),
          )
        ).rule,
      ).toBe('affiliate_code_own');
    });

    it('buys with a code: the page keeps what it takes off, and changing the code makes a new page', async () => {
      await approved(dana, codeFor('buy'));
      const off20 = (await run(affiliateMakeCode, terms(codeFor('buy20')), dana)).code;
      const trial = (
        await run(
          affiliateMakeCode,
          terms(codeFor('buytry'), { percentOffBp: 1000, discountMonths: null, trialDays: 7 }),
          dana,
        )
      ).code;
      const { workspaceId, organizationId } = await business();
      const buy = (code: string | null) =>
        run(foundingBuy, { workspaceId, offerId: MONTHLY, code }, buyer);

      const first = await buy(off20.code);
      expect(first.created).toBe(true);
      expect(await page(first.checkoutId)).toMatchObject({
        status: 'pending',
        amount_cents: 7760,
        full_cents: 9700,
        discount_cents: 1940,
        discount_months: 3,
        trial_days: null,
        code_id: off20.codeId,
      });
      // The same code again is the same page.
      expect(await buy(off20.code.toUpperCase())).toMatchObject({
        checkoutId: first.checkoutId,
        created: false,
      });

      // A trial then 10% off for good: the page only keeps the card, and charges the discounted price later.
      const tried = await buy(trial.code);
      expect(tried.created).toBe(true);
      expect(await page(first.checkoutId)).toMatchObject({
        status: 'failed',
        problem: 'They changed the code before paying.',
      });
      expect(await page(tried.checkoutId)).toMatchObject({
        amount_cents: 8730,
        discount_cents: 970,
        discount_months: null,
        trial_days: 7,
      });

      const none = await buy(null);
      expect(await page(none.checkoutId)).toMatchObject({
        amount_cents: 9700,
        full_cents: null,
        code_id: null,
      });
      expect(
        (
          await refusal(() =>
            run(foundingBuy, { workspaceId, offerId: ONCE, code: trial.code }, buyer),
          )
        ).rule,
      ).toBe('affiliate_code_other_plan');
      // Nobody's credited until the business pays with it.
      const [credited] = await rows(
        admin(),
        sql`select 1 from platform.affiliate_referrals where organization_id = ${organizationId}`,
      );
      expect(credited).toBeUndefined();
    });
  });
});
