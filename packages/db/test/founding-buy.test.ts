/**
 * A business buying its own founding spot, first come, first served (20261027012700).
 *
 * Nobody approves anything: somebody who manages the business's money picks a spot on the plan page, the spot is
 * held for an hour under the cap's lock, and Stripe's word turns it on. Picking the other plan before paying gives
 * the first hold back; paying on the first page anyway wins over the hold that replaced it; paying twice keeps one
 * spot and flags the second payment for a refund. And a business made while a paid spot is on sale has to hold a
 * plan before it opens.
 *
 * These run as the people and the worker involved, the way founding-checkout.test.ts does, each on a business of its
 * own: a business holds one spot at a time, so sharing one would make every test depend on the one before it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  uniq,
  type TestUser,
} from './harness';

const admin = dbs.admin.db;
const YEARLY = 'test_buy_yearly';
const MONTHLY = 'test_buy_monthly';
const FREE = 'test_buy_free';
const OFFERS = [YEARLY, MONTHLY, FREE];

let owner: TestUser;
let member: TestUser;

/** Every test offer back off sale, so a business made by a later test file isn't asked to pay because of these. */
async function closeOffers(): Promise<void> {
  await admin.execute(
    sql`update platform.founding_offers set status = 'closed'
        where id in (${YEARLY}, ${MONTHLY}, ${FREE}) and status = 'open'`,
  );
}

afterAll(async () => {
  await closeOffers();
  await closeAll();
});

beforeAll(async () => {
  [owner, member] = await Promise.all([createTestUser('buy-owner'), createTestUser('buy-member')]);
});

beforeEach(async () => {
  for (const offer of OFFERS) {
    await admin.execute(sql`delete from platform.founding_checkouts where offer_id = ${offer}`);
    await admin.execute(
      sql`delete from app.workspace_plans where grant_id in
            (select id from platform.founding_grants where offer_id = ${offer})`,
    );
    await admin.execute(sql`delete from platform.founding_grants where offer_id = ${offer}`);
  }
  await admin.execute(
    sql`delete from platform.founding_offers where id in (${YEARLY}, ${MONTHLY}, ${FREE})`,
  );
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, billing, paid_yearly, starting_credit_cents, show_counter, sort)
        values (${YEARLY}, 'Buy yearly', 3, 49700, 'open', 'once', true, 0, true, 951),
               (${MONTHLY}, 'Buy monthly', 3, 9700, 'open', 'monthly', false, 0, true, 952),
               (${FREE}, 'Buy free', 3, 0, 'open', 'once', false, 0, true, 953)`,
  );
});

/** A new business, made by `owner` while the spots above are on sale, with `member` on its team. */
async function newBusiness(): Promise<{ org: string; ws: string }> {
  const name = `Buyer ${uniq()}`;
  const { orgId, wsId } = await bootstrapOrganization(owner, name, name);
  await admin.execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${wsId}, ${member.id}, 'member')`,
  );
  return { org: orgId, ws: wsId };
}

type Bought = {
  checkout_id: string;
  grant_id: string;
  status: string;
  session_url: string | null;
  created: boolean;
};

const buy = (ws: string, offer: string, who: TestUser = owner) =>
  as(who)((tx) =>
    rows<Bought>(tx, sql`select * from private.founding_buy(${ws}::uuid, ${offer}, null)`),
  ).then(([row]) => row!);

const paid = (checkoutId: string, ws: string, org: string, cents: number) =>
  asService({ workspaceId: ws, organizationId: org })((tx) =>
    rows<{ outcome: string; plan: string | null }>(
      tx,
      sql`select * from private.founding_checkout_paid(${checkoutId}::uuid, ${`cs_${uniq()}`}, 'pi_test',
            ${cents}, 'cus_test', 'pm_test')`,
    ),
  ).then(([row]) => row!);

const grant = async (id: string) => {
  const [g] = await rows<{ status: string; self_serve: boolean; expires_at: Date | null }>(
    admin,
    sql`select status::text as status, self_serve, expires_at from platform.founding_grants
        where id = ${id}::uuid`,
  );
  return g!;
};

const checkout = async (id: string) => {
  const [c] = await rows<{ status: string; problem: string; amount_cents: number }>(
    admin,
    sql`select status::text as status, problem, amount_cents from platform.founding_checkouts
        where id = ${id}::uuid`,
  );
  return c!;
};

const needsPlan = async (ws: string, who: TestUser = owner): Promise<boolean> => {
  const [row] = await as(who)((tx) =>
    rows<{ needs: boolean }>(tx, sql`select private.workspace_needs_plan(${ws}::uuid) as needs`),
  );
  return row!.needs;
};

describe('buying a spot', () => {
  it('holds a spot for an hour and starts a payment for its price', async () => {
    const { ws } = await newBusiness();
    const out = await buy(ws, MONTHLY);
    expect(out).toMatchObject({ status: 'pending', session_url: null, created: true });

    const g = await grant(out.grant_id);
    expect(g).toMatchObject({ status: 'reserved', self_serve: true });
    const left = new Date(g.expires_at!).getTime() - Date.now();
    expect(left).toBeGreaterThan(55 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000 + 5_000);
    expect(await checkout(out.checkout_id)).toMatchObject({
      status: 'pending',
      amount_cents: 9700,
    });
  });

  it('picks up the payment already under way when pressed again', async () => {
    const { ws } = await newBusiness();
    const first = await buy(ws, YEARLY);
    const again = await buy(ws, YEARLY);
    expect(again).toMatchObject({
      checkout_id: first.checkout_id,
      grant_id: first.grant_id,
      created: false,
    });
  });

  it('is only for somebody who manages the business’s money', async () => {
    const { ws } = await newBusiness();
    const e = await expectPgError(() => buy(ws, YEARLY, member));
    expect(e.code).toBe('42501');
    expect(e.detail).toBe('founding_buy_not_yours');
  });

  it('never sells a free spot, a draft, or one that doesn’t exist', async () => {
    const { ws } = await newBusiness();
    expect((await expectPgError(() => buy(ws, FREE))).detail).toBe('founding_offer_not_for_sale');
    expect((await expectPgError(() => buy(ws, 'test_buy_nothing'))).detail).toBe(
      'founding_offer_missing',
    );
    await admin.execute(
      sql`update platform.founding_offers set status = 'draft' where id = ${MONTHLY}`,
    );
    expect((await expectPgError(() => buy(ws, MONTHLY))).detail).toBe('founding_offer_missing');
  });

  it('is refused under the cap’s lock once every spot is held', async () => {
    for (let i = 0; i < 3; i++) await buy((await newBusiness()).ws, MONTHLY);
    const { ws } = await newBusiness();
    expect((await expectPgError(() => buy(ws, MONTHLY))).detail).toBe('founding_offer_full');
    // The other spot is its own count.
    expect((await buy(ws, YEARLY)).created).toBe(true);
  });

  it('is refused to a business that already has its spot', async () => {
    const { org, ws } = await newBusiness();
    const out = await buy(ws, YEARLY);
    await paid(out.checkout_id, ws, org, 49700);
    expect((await expectPgError(() => buy(ws, MONTHLY))).detail).toBe('founding_org_has_a_seat');
  });
});

describe('changing their mind', () => {
  it('gives the first hold back when they pick the other plan before paying', async () => {
    const { ws } = await newBusiness();
    const yearly = await buy(ws, YEARLY);
    const monthly = await buy(ws, MONTHLY);
    expect(monthly.grant_id).not.toBe(yearly.grant_id);
    expect(await grant(yearly.grant_id)).toMatchObject({ status: 'expired' });
    expect(await checkout(yearly.checkout_id)).toMatchObject({
      status: 'failed',
      problem: 'They picked the other plan instead.',
    });
    expect(await grant(monthly.grant_id)).toMatchObject({ status: 'reserved', self_serve: true });
  });

  it('lets the money win when the first page is paid anyway', async () => {
    const { org, ws } = await newBusiness();
    const yearly = await buy(ws, YEARLY);
    const monthly = await buy(ws, MONTHLY);
    expect(await paid(yearly.checkout_id, ws, org, 49700)).toMatchObject({
      outcome: 'activated',
      plan: 'founding_lifetime',
    });
    expect(await grant(yearly.grant_id)).toMatchObject({ status: 'active' });
    expect(await grant(monthly.grant_id)).toMatchObject({ status: 'expired' });
    expect(await checkout(monthly.checkout_id)).toMatchObject({
      status: 'failed',
      problem: 'They paid for the other plan instead.',
    });
  });

  it('keeps one spot when both pages are paid, and flags the second payment for a refund', async () => {
    const { org, ws } = await newBusiness();
    const yearly = await buy(ws, YEARLY);
    const monthly = await buy(ws, MONTHLY);
    expect((await paid(monthly.checkout_id, ws, org, 9700)).outcome).toBe('activated');
    expect(await paid(yearly.checkout_id, ws, org, 49700)).toMatchObject({ outcome: 'no_seat' });
    expect(await checkout(yearly.checkout_id)).toMatchObject({
      status: 'paid',
      problem: 'Paid, but this business already has a founding spot. Refund this payment.',
    });
    expect(await grant(monthly.grant_id)).toMatchObject({ status: 'active' });
  });
});

describe('paying for it', () => {
  it('puts a monthly spot on the monthly plan, paid a month ahead, with its price and card', async () => {
    const { org, ws } = await newBusiness();
    const out = await buy(ws, MONTHLY);
    expect(await paid(out.checkout_id, ws, org, 9700)).toMatchObject({
      outcome: 'activated',
      plan: 'monthly',
    });
    const [p] = await rows<{
      plan: string;
      status: string;
      price_cents: number;
      current_period_end: Date;
      stripe_card_id: string | null;
    }>(admin, sql`select * from app.workspace_plans where workspace_id = ${ws}::uuid`);
    expect(p).toMatchObject({
      plan: 'monthly',
      status: 'active',
      price_cents: 9700,
      stripe_card_id: 'pm_test',
    });
    const days = (new Date(p!.current_period_end).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('says so on the page they come back to', async () => {
    const { org, ws } = await newBusiness();
    const out = await buy(ws, MONTHLY);
    const state = () =>
      as(owner)((tx) =>
        rows<{ self_serve: boolean; billing: string; seat_active: boolean }>(
          tx,
          sql`select self_serve, billing, seat_active
              from private.founding_checkout_status(${out.checkout_id}::uuid)`,
        ),
      ).then(([row]) => row!);
    expect(await state()).toMatchObject({
      self_serve: true,
      billing: 'monthly',
      seat_active: false,
    });
    await paid(out.checkout_id, ws, org, 9700);
    expect((await state()).seat_active).toBe(true);
  });
});

describe('who has to pay first', () => {
  it('marks a business made while a paid spot is on sale, until it holds a plan', async () => {
    const { org, ws } = await newBusiness();
    const [o] = await rows<{ needs_plan: boolean }>(
      admin,
      sql`select needs_plan from app.organizations where id = ${org}::uuid`,
    );
    expect(o?.needs_plan).toBe(true);
    expect(await needsPlan(ws)).toBe(true);
    // Anybody on the team gets the same answer: it's a yes or no about the business.
    expect(await needsPlan(ws, member)).toBe(true);

    const out = await buy(ws, YEARLY);
    // Held is not paid for.
    expect(await needsPlan(ws)).toBe(true);
    await paid(out.checkout_id, ws, org, 49700);
    expect(await needsPlan(ws)).toBe(false);
  });

  it('never asks a business that isn’t marked', async () => {
    const { org, ws } = await newBusiness();
    await admin.execute(
      sql`update app.organizations set needs_plan = false where id = ${org}::uuid`,
    );
    expect(await needsPlan(ws)).toBe(false);
  });

  it('asks again once the plan has ended', async () => {
    const { org, ws } = await newBusiness();
    const out = await buy(ws, MONTHLY);
    await paid(out.checkout_id, ws, org, 9700);
    await admin.execute(
      sql`update app.workspace_plans set status = 'canceled', canceled_at = now()
          where workspace_id = ${ws}::uuid`,
    );
    expect(await needsPlan(ws)).toBe(true);
  });

  it('is never the business’s own to change', async () => {
    const { org } = await newBusiness();
    const e = await expectPgError(() =>
      as(owner)((tx) =>
        tx.execute(sql`update app.organizations set needs_plan = false where id = ${org}::uuid`),
      ),
    );
    expect(e.detail).toBe('needs_plan_is_ours');
  });
});
