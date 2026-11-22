/**
 * A declined automatic top-up is tried again, in the worker, against the payments stand-in.
 *
 * The decline ladder says a declined top-up is tried again in 6 hours, then a day. Inside a run of top-ups (the 72
 * hours after one) each try was keyed on the run and its place in it alone, so the retry carried the declined
 * try's key, was refused as "already going through", and nothing was charged till the run ended, up to three days
 * on. Each try is keyed on the top-up it follows now, so the retry is its own.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/jobs';
import { sweepWallet } from '../src/money/recharge';
import { FAKE_CARDS } from '../src/payments/fake';
import { admin, drain, moneyWorld, type MoneyWorld } from './money-world';

let w: MoneyWorld;
/** The same world with the wallet on, as `WALLET_MODE=on` runs it. */
let on: MoneyWorld;

const topUps = () =>
  rows<{ status: string; idempotency_key: string }>(
    admin(),
    sql`select status::text as status, idempotency_key from app.wallet_recharges
        where workspace_id = ${w.workspaceId} order by created_at`,
  );

beforeAll(async () => {
  w = await moneyWorld('top-up-retry');
  on = { ...w, s: { ...w.s, wallet: { ...w.s.wallet, mode: 'on' } } };
  const ownerToken = await signInTestUser(w.owner);
  // A card that saves fine and is refused when it's charged with nobody there, as a top-up charges it.
  const card = (body: Record<string, unknown> = {}) =>
    w.app.inject({
      method: 'POST',
      url: '/v1/wallet/card',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId: w.workspaceId, ...body },
    });
  const page = new URL(((await card()).json() as { hostedUrl: string }).hostedUrl);
  const sessionRef = page.searchParams.get('session')!;
  await w.app.inject({
    method: 'POST',
    url: '/payments/fake/card',
    payload: {
      session: sessionRef,
      return: page.searchParams.get('return'),
      instrument: FAKE_CARDS.failsOffSession,
      decision: 'save',
    },
  });
  expect((await card({ sessionRef })).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('a declined top-up inside a run of top-ups', () => {
  it('is tried again once its wait is over, rather than refused as the declined one', async () => {
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    // Under its floor, an hour after a top-up: a run is going, and this is its second.
    await asWorker(on.s.db, scope, (tx) =>
      tx.execute(sql`update app.usage_wallets set floor_cents = balance_cents + 1000, topup_cents = 2_500,
            auto_topup = true, escalation_step = 0, recharges_in_window = 1,
            window_started_at = now() - interval '1 hour', last_recharge_at = now() - interval '1 hour'
          where workspace_id = ${w.workspaceId}`),
    );
    const sweep = () =>
      sweepWallet({
        ...on.s,
        job: { payload: {} } as unknown as JobContext['job'],
        scope,
        attempt: 1,
        now: Date.now(),
      });
    await sweep();
    await drain(on);
    expect((await topUps()).map((t) => t.status)).toEqual(['failed']);
    const [waiting] = await rows<{ paused: boolean; suspended: boolean }>(
      admin(),
      sql`select paused_until > now() as paused, suspended_at is not null as suspended
          from app.usage_wallets where workspace_id = ${w.workspaceId}`,
    );
    expect(waiting).toEqual({ paused: true, suspended: false });
    // Still waiting, nothing is tried.
    await sweep();
    await drain(on);
    expect(await topUps()).toHaveLength(1);

    // The wait is over (6 hours on): the card is tried again, as its own top-up.
    await asWorker(on.s.db, scope, (tx) =>
      tx.execute(
        sql`update app.usage_wallets set paused_until = now() - interval '1 minute'
            where workspace_id = ${w.workspaceId}`,
      ),
    );
    await sweep();
    await drain(on);
    const tried = await topUps();
    expect(tried.map((t) => t.status)).toEqual(['failed', 'failed']);
    expect(tried[0]!.idempotency_key).not.toBe(tried[1]!.idempotency_key);
  });
});
