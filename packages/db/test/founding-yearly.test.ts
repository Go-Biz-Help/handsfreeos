/**
 * The $497 founding seat, paid by the year (20261027009500).
 *
 * A yearly seat is still a seat: the cap and the chain treat it as one. Its first payment keeps the card and starts
 * the year; the worker's sweep finds whose year is up; a refused renewal is paid on a founding checkout of its own,
 * which moves the year on only if it is still the year it was made for; and a business may stop it renewing, after
 * which the seat goes back when the year is over. These run as the people and the worker involved, the way
 * founding-checkout.test.ts does.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rows, sql, type Tx } from '../src/client';
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

afterAll(closeAll);

const admin = dbs.admin.db;
const YEARLY = 'test_yearly_seat';

let owner: TestUser;
let member: TestUser;
let org: string;
let ws: string;

const hash = (token: string): Buffer => createHash('sha256').update(token).digest();

beforeAll(async () => {
  [owner, member] = await Promise.all([
    createTestUser('yearly-owner'),
    createTestUser('yearly-member'),
  ]);
  ({ orgId: org, wsId: ws } = await bootstrapOrganization(owner, 'Yearly Holder', 'Yearly Holder'));
  await admin.execute(
    sql`insert into app.workspace_memberships (workspace_id, user_id, role)
        values (${ws}, ${member.id}, 'member')`,
  );
});

beforeEach(async () => {
  await admin.execute(sql`delete from platform.founding_checkouts where offer_id = ${YEARLY}`);
  await admin.execute(sql`delete from platform.founding_applications where offer_id = ${YEARLY}`);
  await admin.execute(sql`delete from app.workspace_plans where workspace_id = ${ws}`);
  await admin.execute(sql`delete from platform.founding_grants where offer_id = ${YEARLY}`);
  await admin.execute(sql`delete from platform.founding_offers where id = ${YEARLY}`);
  await admin.execute(
    sql`insert into platform.founding_offers
          (id, name, seat_cap, price_cents, status, paid_yearly, starting_credit_cents, show_counter)
        values (${YEARLY}, 'Yearly test', 5, 49700, 'open', true, 0, false)`,
  );
});

const worker = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  asService({ workspaceId: ws, organizationId: org })(fn);

/** Approved, linked, and paid for at Checkout with a card kept: the seat as it is after its first year is bought. */
async function bought(): Promise<{ grantId: string; checkoutId: string }> {
  const token = `link-${uniq()}-${uniq()}`;
  const [grant] = await rows<{ id: string }>(
    admin,
    sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
        values (${YEARLY}, ${org}::uuid, now() + interval '14 days') returning id`,
  );
  await admin.execute(
    sql`insert into platform.founding_applications
          (offer_id, business_name, contact_name, email, status, claim_token_hash, claim_expires_at, grant_id)
        values (${YEARLY}, 'Yearly Holder', 'Owner', ${`${uniq()}@hfos.test`}, 'approved', ${hash(token)},
                now() + interval '14 days', ${grant!.id}::uuid)`,
  );
  const [co] = await as(owner)((tx) =>
    rows<{ checkout_id: string }>(
      tx,
      sql`select * from private.founding_open_checkout(${hash(token)}, ${ws}::uuid)`,
    ),
  );
  const [done] = await paidWithCard(co!.checkout_id, 'pm_first');
  expect(done).toMatchObject({ outcome: 'activated', plan: 'founding_lifetime' });
  return { grantId: grant!.id, checkoutId: co!.checkout_id };
}

const paidWithCard = (checkoutId: string, card: string, cents = 49700) =>
  worker((tx) =>
    rows<{ outcome: string; plan: string | null }>(
      tx,
      sql`select * from private.founding_checkout_paid(${checkoutId}::uuid, ${`cs_${uniq()}`}, 'pi_test',
            ${cents}, 'cus_test', ${card})`,
    ),
  );

const plan = async () => {
  const [p] = await rows<{
    plan: string;
    status: string;
    price_cents: number;
    current_period_end: Date | null;
    stripe_customer_id: string | null;
    stripe_card_id: string | null;
    renewal_stopped_at: Date | null;
    renewal_failed_at: Date | null;
    renewal_count: number;
  }>(admin, sql`select * from app.workspace_plans where workspace_id = ${ws}::uuid`);
  const at = (d: Date | string | null) => (d === null ? null : new Date(d));
  return {
    ...p!,
    current_period_end: at(p!.current_period_end),
    renewal_stopped_at: at(p!.renewal_stopped_at),
    renewal_failed_at: at(p!.renewal_failed_at),
  };
};

const setPeriod = (expr: ReturnType<typeof sql>) =>
  admin.execute(
    sql`update app.workspace_plans set current_period_end = ${expr} where workspace_id = ${ws}::uuid`,
  );

const due = () =>
  asService({})((tx) =>
    rows<{ grant_id: string; workspace_id: string }>(
      tx,
      sql`select * from private.founding_renewals_due(500)`,
    ),
  );

const setRenewing = (user: TestUser, renewing: boolean) =>
  as(user)((tx) =>
    rows<{ renewing: boolean; changed: boolean }>(
      tx,
      sql`select * from private.founding_set_renewing(${ws}::uuid, ${renewing})`,
    ),
  );

const openRenewal = (user: TestUser) =>
  as(user)((tx) =>
    rows<{ checkout_id: string; created: boolean }>(
      tx,
      sql`select * from private.founding_open_renewal_checkout(${ws}::uuid)`,
    ),
  );

describe('a yearly seat', () => {
  it('is a seat: the cap counts it, and the website takes applications for it', async () => {
    const [applied] = await asService({})((tx) =>
      rows<{ status: string }>(
        tx,
        sql`select * from private.founding_apply(${YEARLY}, 'Somebody', 'Them', ${`${uniq()}@hfos.test`},
              '', '', '', '', '', '')`,
      ),
    );
    expect(applied!.status).toBe('pending');
    await bought();
    const [held] = await rows<{ n: number }>(
      admin,
      sql`select private.founding_seats_held(${YEARLY}) as n`,
    );
    expect(Number(held!.n)).toBe(1);
    // A seat in its own right, billed `once` like any seat; the app is told it is paid yearly.
    const [billing] = await as(owner)((tx) =>
      rows<{ billing: string }>(
        tx,
        sql`select private.founding_offer_billing(${YEARLY}) as billing`,
      ),
    );
    expect(billing!.billing).toBe('yearly');
  });

  it('keeps its price, a year from today and the card from its first payment', async () => {
    await bought();
    const p = await plan();
    expect(p).toMatchObject({
      plan: 'founding_lifetime',
      status: 'active',
      price_cents: 49700,
      stripe_customer_id: 'cus_test',
      stripe_card_id: 'pm_first',
      renewal_count: 0,
    });
    const days = (p.current_period_end!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(364);
    expect(days).toBeLessThan(367);
  });

  it('is due when its year is up, and not while it is stopped or waiting on another card', async () => {
    const { grantId } = await bought();
    expect((await due()).some((d) => d.grant_id === grantId)).toBe(false);
    await setPeriod(sql`now() - interval '1 minute'`);
    expect((await due()).some((d) => d.grant_id === grantId)).toBe(true);

    await admin.execute(
      sql`update app.workspace_plans set renewal_failed_at = now() where workspace_id = ${ws}::uuid`,
    );
    expect((await due()).some((d) => d.grant_id === grantId)).toBe(false);
    await admin.execute(
      sql`update app.workspace_plans set renewal_failed_at = null, renewal_stopped_at = now()
          where workspace_id = ${ws}::uuid`,
    );
    expect((await due()).some((d) => d.grant_id === grantId)).toBe(false);
  });

  it('is never due when staff gave it: no year, no price', async () => {
    const [g] = await rows<{ id: string }>(
      admin,
      sql`insert into platform.founding_grants (offer_id, organization_id, workspace_id, status, activated_at)
          values (${YEARLY}, ${org}::uuid, ${ws}::uuid, 'active', now()) returning id`,
    );
    await admin.execute(
      sql`insert into app.workspace_plans (workspace_id, organization_id, plan, status, grant_id, price_cents)
          values (${ws}::uuid, ${org}::uuid, 'founding_lifetime', 'active', ${g!.id}::uuid, 0)`,
    );
    expect((await due()).some((d) => d.grant_id === g!.id)).toBe(false);
  });
});

describe('stopping it renewing', () => {
  it('is for somebody who manages the money, and can be undone while the year is paid for', async () => {
    await bought();
    expect((await expectPgError(() => setRenewing(member, false))).detail).toBe(
      'founding_renewal_not_yours',
    );
    expect((await setRenewing(owner, false))[0]).toMatchObject({ renewing: false, changed: true });
    expect((await plan()).renewal_stopped_at).not.toBeNull();
    expect((await setRenewing(owner, false))[0]).toMatchObject({ changed: false });
    expect((await setRenewing(owner, true))[0]).toMatchObject({ renewing: true, changed: true });
    expect((await plan()).renewal_stopped_at).toBeNull();
  });

  it('cannot be started again once the year is over', async () => {
    await bought();
    await setRenewing(owner, false);
    await setPeriod(sql`now() - interval '1 minute'`);
    expect((await expectPgError(() => setRenewing(owner, true))).detail).toBe('founding_year_over');
  });

  it('is refused on a seat that is not paid by the year', async () => {
    expect((await expectPgError(() => setRenewing(owner, false))).detail).toBe(
      'founding_not_yearly',
    );
  });

  it('gives the seat back when the year is over: revoked, with the reason, and the plan canceled', async () => {
    const { grantId } = await bought();
    await setRenewing(owner, false);
    await setPeriod(sql`now() - interval '1 minute'`);
    const [ended] = await asService({})((tx) =>
      rows<{ n: number }>(tx, sql`select private.founding_end_stopped_years() as n`),
    );
    expect(Number(ended!.n)).toBeGreaterThanOrEqual(1);
    const [g] = await rows<{ status: string; revoke_reason: string }>(
      admin,
      sql`select status::text as status, revoke_reason from platform.founding_grants where id = ${grantId}::uuid`,
    );
    expect(g!.status).toBe('revoked');
    expect(g!.revoke_reason).toMatch(/stopped it renewing/);
    expect((await plan()).status).toBe('canceled');
  });

  it('leaves a seat that is still renewing alone, however late its year', async () => {
    const { grantId } = await bought();
    await setPeriod(sql`now() - interval '1 minute'`);
    await asService({})((tx) => rows(tx, sql`select private.founding_end_stopped_years()`));
    const [g] = await rows<{ status: string }>(
      admin,
      sql`select status::text as status from platform.founding_grants where id = ${grantId}::uuid`,
    );
    expect(g!.status).toBe('active');
  });
});

describe('a refused renewal, paid with another card', () => {
  const refuse = () =>
    admin.execute(
      sql`update app.workspace_plans
             set renewal_failed_at = now(), renewal_problem = 'Your card was declined.', status = 'past_due',
                 current_period_end = now() - interval '1 day'
           where workspace_id = ${ws}::uuid`,
    );

  it('is only offered while a renewal is waiting', async () => {
    await bought();
    expect((await expectPgError(() => openRenewal(owner))).detail).toBe('founding_renewal_not_due');
    await refuse();
    expect((await expectPgError(() => openRenewal(member))).detail).toBe(
      'founding_renewal_not_yours',
    );
  });

  it('moves that year on, makes the new card next year’s, and is picked back up rather than made twice', async () => {
    await bought();
    await refuse();
    const before = (await plan()).current_period_end!;
    const [first] = await openRenewal(owner);
    expect(first!.created).toBe(true);
    const [again] = await openRenewal(owner);
    expect(again).toMatchObject({ checkout_id: first!.checkout_id, created: false });

    // The page somebody comes back to waits for the year to move on, not for the seat (it was on all along).
    const view = () =>
      as(owner)((tx) =>
        rows<{ renewal: boolean; seat_active: boolean; billing: string }>(
          tx,
          sql`select * from private.founding_checkout_state(${first!.checkout_id}::uuid)`,
        ),
      );
    expect((await view())[0]).toMatchObject({
      renewal: true,
      seat_active: false,
      billing: 'yearly',
    });

    expect((await paidWithCard(first!.checkout_id, 'pm_second'))[0]).toMatchObject({
      outcome: 'renewed',
    });
    const p = await plan();
    expect(p).toMatchObject({
      status: 'active',
      stripe_card_id: 'pm_second',
      renewal_failed_at: null,
      renewal_count: 1,
    });
    const year = new Date(before);
    year.setUTCFullYear(year.getUTCFullYear() + 1);
    expect(p.current_period_end!.toISOString()).toBe(year.toISOString());
    expect((await view())[0]).toMatchObject({ seat_active: true });
    expect((await paidWithCard(first!.checkout_id, 'pm_second'))[0]).toMatchObject({
      outcome: 'already',
    });
  });

  it('is recorded for staff, not counted twice, when the year moved on before it was paid', async () => {
    await bought();
    await refuse();
    const [page] = await openRenewal(owner);
    await admin.execute(
      sql`update app.workspace_plans
             set current_period_end = current_period_end + interval '1 year', renewal_failed_at = null
           where workspace_id = ${ws}::uuid`,
    );
    const moved = (await plan()).current_period_end!.toISOString();
    expect((await paidWithCard(page!.checkout_id, 'pm_late'))[0]).toMatchObject({
      outcome: 'no_seat',
    });
    expect((await plan()).current_period_end!.toISOString()).toBe(moved);
    const [c] = await rows<{ problem: string }>(
      admin,
      sql`select problem from platform.founding_checkouts where id = ${page!.checkout_id}::uuid`,
    );
    expect(c!.problem).toMatch(/already paid/);
  });
});

describe('the worker deployed before', () => {
  it('still records a payment through the four-argument function, with no card kept', async () => {
    const token = `link-${uniq()}-${uniq()}`;
    const [grant] = await rows<{ id: string }>(
      admin,
      sql`insert into platform.founding_grants (offer_id, organization_id, expires_at)
          values (${YEARLY}, ${org}::uuid, now() + interval '14 days') returning id`,
    );
    await admin.execute(
      sql`insert into platform.founding_applications
            (offer_id, business_name, contact_name, email, status, claim_token_hash, claim_expires_at, grant_id)
          values (${YEARLY}, 'Yearly Holder', 'Owner', ${`${uniq()}@hfos.test`}, 'approved', ${hash(token)},
                  now() + interval '14 days', ${grant!.id}::uuid)`,
    );
    const [co] = await as(owner)((tx) =>
      rows<{ checkout_id: string }>(
        tx,
        sql`select * from private.founding_open_checkout(${hash(token)}, ${ws}::uuid)`,
      ),
    );
    const [done] = await worker((tx) =>
      rows<{ outcome: string }>(
        tx,
        sql`select * from private.founding_checkout_paid(${co!.checkout_id}::uuid, ${`cs_${uniq()}`}, 'pi',
              49700)`,
      ),
    );
    expect(done!.outcome).toBe('activated');
    expect(await plan()).toMatchObject({ price_cents: 49700, stripe_card_id: null });
  });
});
