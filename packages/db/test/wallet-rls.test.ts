/**
 * The wallet's rules, in the database rather than in the code that writes to it (M16, step 2).
 *
 * Four of these are the ones that decide whether the wallet is trustworthy at all:
 * - a worker's ledger insert moves the balance, and nothing else may;
 * - the same idempotency key twice makes **one** row, because that is a webhook storm not a second text;
 * - any update or delete of a ledger row is refused, whoever asks;
 * - a business owns its four settings and not a penny of its balance.
 *
 * The fifth is the one that is easy to get wrong and expensive to discover: the balance may go **below zero**.
 * Every other money column in this repo is `>= 0`, so the first person to "fix" this one needs a test telling
 * them not to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rows, sql } from '../src/client';
import {
  as,
  asService,
  bootstrapOrganization,
  closeAll,
  createTestUser,
  dbs,
  expectPgError,
  type TestUser,
} from './harness';

let owner: TestUser;
let outsider: TestUser;
interface Business {
  readonly ws: string;
  readonly org: string;
}
let A: Business;
let B: Business;

const worker = (b: Business) => asService({ workspaceId: b.ws, organizationId: b.org });
const detailOf = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  return { code: e.code, detail: e.detail };
};

/**
 * Refused — without claiming which lock did it.
 *
 * These rows are protected twice: `authenticated` has no INSERT privilege on either table at all, and the
 * guards refuse the write on top of that. A missing table privilege is checked before any trigger runs, so
 * the guard never gets to speak and there is no `detail` to assert. Asserting the guard's wording here was
 * asserting the weaker of the two locks, and the run against a real database said so.
 */
const refused = async (fn: () => Promise<unknown>) => {
  const e = await expectPgError(fn);
  expect(e.code).toBe('42501');
};

/** The balance the cache holds, and what the ledger actually adds up to. */
async function balances(b: Business): Promise<{ cached: number; summed: number }> {
  const [row] = await rows<{ cached: number; summed: number }>(
    dbs.admin.db,
    sql`select w.balance_cents::int as cached,
          coalesce((select sum(l.amount_cents) from app.usage_ledger l
            where l.workspace_id = ${b.ws}), 0)::int as summed
        from app.usage_wallets w where w.workspace_id = ${b.ws}`,
  );
  return { cached: row?.cached ?? 0, summed: row?.summed ?? 0 };
}

/** One ledger row as the worker, the way `chargeUsage` will write it. */
const spend = (b: Business, cents: number, key: string) =>
  worker(b)((tx) =>
    tx.execute(
      sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, idempotency_key, subject)
          values (${b.ws}, ${b.org}, 'spend', ${-Math.abs(cents)}, ${key}, 'A text')
          on conflict (workspace_id, idempotency_key) do nothing`,
    ),
  );

beforeAll(async () => {
  [owner, outsider] = await Promise.all([
    createTestUser('wallet-owner'),
    createTestUser('wallet-outsider'),
  ]);
  const orgA = await bootstrapOrganization(owner, 'Wallet Org A', 'Wallet A');
  A = { ws: orgA.wsId, org: orgA.orgId };
  const orgB = await bootstrapOrganization(outsider, 'Wallet Org B', 'Wallet B');
  B = { ws: orgB.wsId, org: orgB.orgId };
  await worker(A)((tx) =>
    tx.execute(
      sql`insert into app.usage_wallets (workspace_id, organization_id) values (${A.ws}, ${A.org})
          on conflict (workspace_id) do nothing`,
    ),
  );
});
afterAll(closeAll);

describe('the balance', () => {
  it('moves when the worker writes a ledger row, and matches what the ledger adds up to', async () => {
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, idempotency_key, subject)
            values (${A.ws}, ${A.org}, 'topup', 2500, 'topup:test-1', 'Top-up')`,
      ),
    );
    await spend(A, 200, 'sms:SMtest1');
    const { cached, summed } = await balances(A);
    expect(cached).toBe(2300);
    expect(summed).toBe(2300);
  });

  it('writes what was left onto the row itself, so a statement needs no window function', async () => {
    const [row] = await rows<{ after: number }>(
      dbs.admin.db,
      sql`select balance_after_cents::int as after from app.usage_ledger
          where workspace_id = ${A.ws} and idempotency_key = 'sms:SMtest1'`,
    );
    expect(row?.after).toBe(2300);
  });

  it('opens a wallet for a business that spends before anybody opened one', async () => {
    await spend(B, 150, 'sms:SMtest-b');
    const { cached, summed } = await balances(B);
    expect(cached).toBe(-150);
    expect(summed).toBe(-150);
  });

  /**
   * Deliberate, and the opposite of every other money column here. An inbound call arrives whether or not there
   * is money and the carrier has already billed us; refusing it would save nothing and would have the
   * business's own customers hear "not in service".
   */
  it('goes below zero, because inbound usage does not ask first', async () => {
    await spend(A, 10_000, 'call:CAtest-big');
    const { cached, summed } = await balances(A);
    expect(cached).toBeLessThan(0);
    expect(cached).toBe(summed);
  });

  it('is never written by a person, even one who may change the settings', async () => {
    const before = await balances(A);
    await refused(() =>
      as(owner)((tx) =>
        tx.execute(
          sql`update app.usage_wallets set balance_cents = 999999 where workspace_id = ${A.ws}`,
        ),
      ),
    );
    // The effect, not the wording: the balance is exactly where the ledger left it.
    expect((await balances(A)).cached).toBe(before.cached);
  });
});

describe('the ledger', () => {
  it('counts one event once, however many times it is reported', async () => {
    // `sent`, then `delivered`, then a webhook retry of both: one text, one charge.
    const before = await balances(A);
    for (let i = 0; i < 5; i += 1) await spend(A, 200, 'sms:SMtwice');
    const after = await balances(A);
    expect(after.cached).toBe(before.cached - 200);
    const [count] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_ledger
          where workspace_id = ${A.ws} and idempotency_key = 'sms:SMtwice'`,
    );
    expect(count?.n).toBe(1);
  });

  it('lets two businesses use the same key, because a key is only unique within a business', async () => {
    await spend(A, 100, 'sms:SMshared');
    await spend(B, 100, 'sms:SMshared');
    const [count] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_ledger where idempotency_key = 'sms:SMshared'`,
    );
    expect(count?.n).toBe(2);
  });

  it('refuses to be changed, whoever asks — a correction is a new row', async () => {
    for (const change of [
      sql`update app.usage_ledger set amount_cents = -1 where workspace_id = ${A.ws}`,
      sql`delete from app.usage_ledger where workspace_id = ${A.ws}`,
    ])
      expect(await detailOf(() => worker(A)((tx) => tx.execute(change)))).toEqual({
        code: '42501',
        detail: 'usage_ledger_append_only',
      });
  });

  it('refuses a row from a person, so nobody can spend their own balance down', async () => {
    await refused(() =>
      as(owner)((tx) =>
        tx.execute(
          sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, idempotency_key)
              values (${A.ws}, ${A.org}, 'topup', 100000, 'topup:free-money')`,
        ),
      ),
    );
    const [found] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_ledger
          where workspace_id = ${A.ws} and idempotency_key = 'topup:free-money'`,
    );
    expect(found?.n).toBe(0);
  });

  it('refuses a row that changes nothing and a spend that is money in', async () => {
    for (const bad of [
      sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, idempotency_key)
          values (${A.ws}, ${A.org}, 'spend', 0, 'sms:SMzero')`,
      sql`insert into app.usage_ledger (workspace_id, organization_id, kind, amount_cents, idempotency_key)
          values (${A.ws}, ${A.org}, 'spend', 500, 'sms:SMbackwards')`,
    ])
      expect((await expectPgError(() => worker(A)((tx) => tx.execute(bad)))).code).toBe('23514');
  });

  it('refuses a priced row that does not say what it was priced from', async () => {
    expect(
      (
        await expectPgError(() =>
          worker(A)((tx) =>
            tx.execute(
              sql`insert into app.usage_ledger
                    (workspace_id, organization_id, kind, amount_cents, idempotency_key, rate_key)
                  values (${A.ws}, ${A.org}, 'spend', -200, 'sms:SMunpriced', 'sms.outbound.segment')`,
            ),
          ),
        )
      ).code,
    ).toBe('23514');
  });
});

describe('who sees what', () => {
  it('shows a business its own rows and nobody else’s', async () => {
    const mine = await as(owner)((tx) =>
      rows<{ n: number }>(tx, sql`select count(*)::int as n from app.usage_ledger`),
    );
    const theirs = await as(outsider)((tx) =>
      rows<{ n: number }>(tx, sql`select count(*)::int as n from app.usage_ledger`),
    );
    expect(mine[0]!.n).toBeGreaterThan(0);
    // B's own rows, and not one of A's.
    expect(theirs[0]!.n).toBe(2);
  });

  it('lets a business change its own four settings', async () => {
    await as(owner)((tx) =>
      tx.execute(
        sql`update app.usage_wallets set auto_topup = false, floor_cents = 2000, topup_cents = 5000,
              overdraft_cents = 500 where workspace_id = ${A.ws}`,
      ),
    );
    const [w] = await rows<{ floor: number; topup: number }>(
      dbs.admin.db,
      sql`select floor_cents::int as floor, topup_cents::int as topup from app.usage_wallets
          where workspace_id = ${A.ws}`,
    );
    expect(w).toEqual({ floor: 2000, topup: 5000 });
  });

  it('never lets a person write the card, which is the provider’s', async () => {
    expect(
      await detailOf(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.usage_wallets set method_token = 'pm_stolen', customer_ref = 'cus_x'
                where workspace_id = ${A.ws}`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'wallet_card_is_the_providers' });
  });

  it('never lets a person undo a suspension or reset the decline ladder', async () => {
    // Suspend it first. This used to set nulls over nulls on a wallet that had never been suspended, so
    // every `is distinct from` was false, the guard had nothing to refuse, and the update "succeeded" —
    // the test passed for years by asserting nothing.
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.usage_wallets set declines_in_row = 3, suspended_at = now(),
              suspended_reason = 'card declined three times' where workspace_id = ${A.ws}`,
      ),
    );
    expect(
      await detailOf(() =>
        as(owner)((tx) =>
          tx.execute(
            sql`update app.usage_wallets set declines_in_row = 0, paused_until = null, suspended_at = null,
                  suspended_reason = null where workspace_id = ${A.ws}`,
          ),
        ),
      ),
    ).toEqual({ code: '42501', detail: 'wallet_ladders_are_ours' });
    // And it is still suspended.
    const [still] = await rows<{ suspended: boolean }>(
      dbs.admin.db,
      sql`select suspended_at is not null as suspended from app.usage_wallets where workspace_id = ${A.ws}`,
    );
    expect(still?.suspended).toBe(true);
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.usage_wallets set declines_in_row = 0, suspended_at = null, suspended_reason = null
            where workspace_id = ${A.ws}`,
      ),
    );
  });

  it('is never opened with money already in it', async () => {
    await refused(() =>
      as(outsider)((tx) =>
        tx.execute(
          sql`insert into app.usage_wallets (workspace_id, organization_id, balance_cents)
              values (${B.ws}, ${B.org}, 500000)`,
        ),
      ),
    );
    const [found] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_wallets
          where workspace_id = ${B.ws} and balance_cents > 0`,
    );
    expect(found?.n).toBe(0);
  });
});

/**
 * Opening one, which is the only write on this table a person's own press makes.
 *
 * The table stays shut to them — no insert privilege, no insert policy — because what must stay impossible
 * is opening a wallet of one's *choosing*: with money on it, a card on it, or `stage` set to `off` so the
 * business's own spending limit never fires. An empty one for a business they already run is harmless, and
 * `private.open_usage_wallet` is the one door to it.
 */
describe('opening a wallet', () => {
  it('refuses somebody who cannot spend that business’s money', async () => {
    expect(
      await detailOf(() =>
        as(owner)((tx) => tx.execute(sql`select private.open_usage_wallet(${B.ws}::uuid)`)),
      ),
    ).toEqual({ code: '42501', detail: 'wallet_open_is_money_manage' });
    const [found] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_wallets where workspace_id = ${B.ws}`,
    );
    expect(found?.n).toBe(0);
  });

  it('opens an empty one for somebody who can, with the limit still on', async () => {
    await as(outsider)((tx) => tx.execute(sql`select private.open_usage_wallet(${B.ws}::uuid)`));
    const [w] = await rows<{
      org: string;
      stage: string;
      balance: number;
      method_token: string | null;
    }>(
      dbs.admin.db,
      sql`select organization_id as org, stage::text as stage, balance_cents::int as balance, method_token
          from app.usage_wallets where workspace_id = ${B.ws}`,
    );
    // The organisation is read from the workspace, never taken from whoever asked.
    expect(w).toMatchObject({ org: B.org, stage: 'off', balance: 0 });
    expect(w?.method_token).toBeNull();
  });

  it('is one wallet however many times it is asked for', async () => {
    await as(outsider)((tx) => tx.execute(sql`select private.open_usage_wallet(${B.ws}::uuid)`));
    const [found] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.usage_wallets where workspace_id = ${B.ws}`,
    );
    expect(found?.n).toBe(1);
  });

  it('is still the only way in: a person cannot write the row themselves', async () => {
    // A's own owner, who may spend A's money and still may not open its wallet by hand.
    await refused(() =>
      as(owner)((tx) =>
        tx.execute(
          sql`insert into app.usage_wallets (workspace_id, organization_id)
              values (${A.ws}, ${A.org}) on conflict (workspace_id) do nothing`,
        ),
      ),
    );
  });
});

describe('a top-up', () => {
  it('lets one business have only one waiting at a time', async () => {
    await worker(A)((tx) =>
      tx.execute(
        sql`insert into app.wallet_recharges (workspace_id, organization_id, amount_cents)
            values (${A.ws}, ${A.org}, 2500)`,
      ),
    );
    // Two events crossing the floor in the same second must not charge the card twice.
    expect(
      (
        await expectPgError(() =>
          worker(A)((tx) =>
            tx.execute(
              sql`insert into app.wallet_recharges (workspace_id, organization_id, amount_cents)
                  values (${A.ws}, ${A.org}, 2500)`,
            ),
          ),
        )
      ).code,
    ).toBe('23505');
  });

  it('never moves backwards, so a late callback cannot un-succeed one', async () => {
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.wallet_recharges set status = 'succeeded', succeeded_at = now()
            where workspace_id = ${A.ws} and status = 'pending'`,
      ),
    );
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.wallet_recharges set status = 'failed' where workspace_id = ${A.ws}`,
      ),
    );
    const [r] = await rows<{ status: string }>(
      dbs.admin.db,
      sql`select status::text as status from app.wallet_recharges where workspace_id = ${A.ws}`,
    );
    expect(r?.status).toBe('succeeded');
  });

  it('is never written by a person', async () => {
    await refused(() =>
      as(owner)((tx) =>
        tx.execute(
          sql`insert into app.wallet_recharges (workspace_id, organization_id, amount_cents)
              values (${A.ws}, ${A.org}, 100000)`,
        ),
      ),
    );
    const [found] = await rows<{ n: number }>(
      dbs.admin.db,
      sql`select count(*)::int as n from app.wallet_recharges
          where workspace_id = ${A.ws} and amount_cents = 100000`,
    );
    expect(found?.n).toBe(0);
  });
});

describe('the nightly drift check', () => {
  it('finds nothing while every wallet matches its ledger', async () => {
    const drift = await rows<{ workspace_id: string }>(
      dbs.admin.db,
      sql`select workspace_id from private.usage_wallet_drift()`,
    );
    expect(drift).toEqual([]);
  });

  it('finds a wallet somebody moved behind the ledger’s back', async () => {
    // Through the worker's own scope, which `private.guard_usage_wallet` exempts — the admin connection is
    // refused by it like anybody else, which is a stronger rule than this test used to assume.
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.usage_wallets set balance_cents = balance_cents + 777 where workspace_id = ${A.ws}`,
      ),
    );
    const drift = await rows<{ workspace_id: string; drift_cents: number }>(
      dbs.admin.db,
      sql`select workspace_id, drift_cents::int as drift_cents from private.usage_wallet_drift()`,
    );
    expect(drift).toEqual([{ workspace_id: A.ws, drift_cents: 777 }]);
    await worker(A)((tx) =>
      tx.execute(
        sql`update app.usage_wallets set balance_cents = balance_cents - 777 where workspace_id = ${A.ws}`,
      ),
    );
  });
});
