/**
 * Topping up the business's own balance, in the worker, against the payments stand-in:
 *
 * - **Top up now charges the card**, on HandsFreeOS's own account, and the next press works once the first has gone
 *   through. Nothing used to queue a press, so the card was never charged, and the waiting top-up then refused every
 *   one after it, automatic ones too.
 * - **With the wallet not on, a press is cancelled**: never charged, and never left waiting to hold the next one up.
 * - **The hourly check arms a sweep** for a wallet that could need a top-up. It used to read no wallets at all.
 */
import { walletTopUp } from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/jobs';
import { planWallets, RECHARGE_JOBS, walletSweepKey } from '../src/money/recharge';
import { FAKE_CARDS } from '../src/payments/fake';
import { admin, drain, moneyWorld, run, type MoneyWorld } from './money-world';

let w: MoneyWorld;
/** The same world with the wallet on, as `WALLET_MODE=on` runs it. */
let on: MoneyWorld;

const topUp = (amountCents: number) =>
  run(w, walletTopUp, { workspaceId: w.workspaceId, amountCents });

const topUps = () =>
  rows<{ status: string; amount_cents: number; failure_message: string | null }>(
    admin(),
    sql`select status::text as status, amount_cents::int as amount_cents, failure_message
        from app.wallet_recharges where workspace_id = ${w.workspaceId} order by created_at`,
  );

const balance = async () =>
  (
    await rows<{ cents: number }>(
      admin(),
      sql`select balance_cents::int as cents from app.usage_wallets where workspace_id = ${w.workspaceId}`,
    )
  )[0]?.cents ?? 0;

/** What our own Stripe account charged for this business. */
const charges = () =>
  w.s.payments.fake.platformCharges().filter((c) => c.metadata['workspace_id'] === w.workspaceId);

beforeAll(async () => {
  w = await moneyWorld('top-up');
  on = { ...w, s: { ...w.s, wallet: { ...w.s.wallet, mode: 'on' } } };
  const ownerToken = await signInTestUser(w.owner);
  // A card on the balance, typed on the provider's own page, as a business puts one on.
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
      instrument: FAKE_CARDS.succeeds,
      decision: 'save',
    },
  });
  expect((await card({ sessionRef })).statusCode).toBe(200);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('topping up the balance', () => {
  it('charges the card when somebody presses Top up now, and again the next time', async () => {
    expect(await balance()).toBe(0);
    await topUp(2_500);
    await drain(on);
    expect(await topUps()).toEqual([
      expect.objectContaining({ status: 'succeeded', amount_cents: 2_500 }),
    ]);
    expect(charges()).toEqual([
      expect.objectContaining({ amountCents: 2_500, status: 'succeeded' }),
    ]);
    expect(await balance()).toBe(2_500);
    // The one that went through no longer holds the next one up.
    await topUp(5_000);
    await drain(on);
    expect(charges()).toHaveLength(2);
    expect(await balance()).toBe(7_500);
  });

  it('cancels a press while the wallet is off, rather than charging it or leaving it waiting', async () => {
    await topUp(2_500);
    await drain(w);
    expect((await topUps()).at(-1)).toMatchObject({
      status: 'cancelled',
      failure_message: 'Top-ups are switched off right now, so the card wasn’t charged.',
    });
    expect(charges()).toHaveLength(2);
    expect(await balance()).toBe(7_500);
    // And the next press isn't refused as one already going through.
    await topUp(2_500);
    await drain(on);
    expect(charges()).toHaveLength(3);
    expect(await balance()).toBe(10_000);
  });

  it('arms the hourly sweep for a wallet that could need a top-up', async () => {
    await planWallets({
      ...on.s,
      job: { payload: {} } as unknown as JobContext['job'],
      scope: {},
      attempt: 1,
      now: Date.now(),
    });
    const [sweep] = await rows<{ status: string }>(
      admin(),
      sql`select status::text as status from app.scheduled_jobs
          where kind = ${RECHARGE_JOBS.sweep} and dedupe_key = ${walletSweepKey(w.workspaceId)}`,
    );
    expect(sweep?.status).toBe('pending');
  });
});
