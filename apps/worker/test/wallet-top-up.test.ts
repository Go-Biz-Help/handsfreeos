/**
 * Topping up the business's own balance, in the worker, against the payments stand-in:
 *
 * - **Top up now charges the card**, on HandsFreeOS's own account, and the next press works once the first has gone
 *   through. Nothing used to queue a press, so the card was never charged, and the waiting top-up then refused every
 *   one after it, automatic ones too.
 * - **With the wallet not on, a press is cancelled**: never charged, and never left waiting to hold the next one up.
 * - **The hourly check arms a sweep** for a wallet that could need a top-up. It used to read no wallets at all.
 * - **The sweep tops up a balance under its floor.** It threw on every run from 12 Nov (a timestamp read as text was
 *   treated as a Date), so a business with auto top-up on and a working card ran down to nothing.
 * - **A top-up that goes through lifts a suspension.** A suspended balance took the money for a Top up now and
 *   still said texts and calls had stopped, and never topped itself up again.
 * - **Top-ups close together double in every run, not only the first.** A run was only ever started when there
 *   had never been one, so a business's first run never ended, and every top-up after its first three days was
 *   its own amount (the owner, 23 Nov 2026: "Yes, make it work as designed").
 */
import { executeCommand, walletGet, walletSuspend, walletTopUp } from '@hfos/core/server';
import { asWorker, rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobContext } from '../src/jobs';
import { planWallets, RECHARGE_JOBS, sweepWallet, walletSweepKey } from '../src/money/recharge';
import { FAKE_CARDS } from '../src/payments/fake';
import { systemActor, workerMeta } from '../src/services';
import { query } from './booking-world';
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
    // The $5 every business starts with.
    expect(await balance()).toBe(500);
    await topUp(2_500);
    await drain(on);
    expect(await topUps()).toEqual([
      expect.objectContaining({ status: 'succeeded', amount_cents: 2_500 }),
    ]);
    expect(charges()).toEqual([
      expect.objectContaining({ amountCents: 2_500, status: 'succeeded' }),
    ]);
    expect(await balance()).toBe(3_000);
    // The one that went through no longer holds the next one up.
    await topUp(5_000);
    await drain(on);
    expect(charges()).toHaveLength(2);
    expect(await balance()).toBe(8_000);
  });

  it('cancels a press while the wallet is off, rather than charging it or leaving it waiting', async () => {
    await topUp(2_500);
    await drain(w);
    expect((await topUps()).at(-1)).toMatchObject({
      status: 'cancelled',
      failure_message: 'Top-ups are switched off right now, so the card wasn’t charged.',
    });
    expect(charges()).toHaveLength(2);
    expect(await balance()).toBe(8_000);
    // And the next press isn't refused as one already going through.
    await topUp(2_500);
    await drain(on);
    expect(charges()).toHaveLength(3);
    expect(await balance()).toBe(10_500);
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

  it('tops up a balance that has fallen under its floor when the hourly sweep runs, once', async () => {
    // A quiet wallet: no run of top-ups going, so the sweep asks for the business's own amount. The ladder is
    // HandsFreeOS's to write, so it is reset as the worker would.
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    const floor = (await balance()) + 1_000;
    await asWorker(on.s.db, scope, (tx) =>
      tx.execute(sql`update app.usage_wallets set floor_cents = ${floor}, topup_cents = 2_500,
            auto_topup = true, escalation_step = 0, recharges_in_window = 0, window_started_at = null,
            last_recharge_at = null
          where workspace_id = ${w.workspaceId}`),
    );
    const before = charges().length;
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
    expect(charges().slice(before)).toEqual([
      expect.objectContaining({ amountCents: 2_500, status: 'succeeded' }),
    ]);
    expect((await topUps()).at(-1)).toMatchObject({ status: 'succeeded', amount_cents: 2_500 });
    // Back over its floor, the next hour's sweep leaves the card alone.
    await sweep();
    await drain(on);
    expect(charges().slice(before)).toHaveLength(1);
  });

  it('puts a suspended balance back to normal once a top-up goes through on its card', async () => {
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    // The card was declined till the balance was suspended; the owner sorted it out with the bank.
    await executeCommand(
      on.s.db,
      walletSuspend,
      { workspaceId: w.workspaceId, reason: 'The card was declined.' },
      systemActor(scope),
      workerMeta(),
    );
    const suspended = async () =>
      (
        await rows<{ suspended_at: string | null; suspended_reason: string | null }>(
          admin(),
          sql`select suspended_at, suspended_reason from app.usage_wallets
              where workspace_id = ${w.workspaceId}`,
        )
      )[0];
    expect((await suspended())?.suspended_at).not.toBeNull();
    const before = await balance();
    await topUp(2_500);
    await drain(on);
    expect(await balance()).toBe(before + 2_500);
    expect(await suspended()).toEqual({ suspended_at: null, suspended_reason: null });
    const said = await rows<{ event_type: string }>(
      admin(),
      sql`select event_type from app.events
          where workspace_id = ${w.workspaceId} and event_type = 'wallet.resumed'`,
    );
    expect(said).toHaveLength(1);
  });

  it('doubles top-ups close together in a later run, not only in the business’s first three days', async () => {
    const scope = { workspaceId: w.workspaceId, organizationId: w.organizationId };
    // A run of three top-ups that ended weeks ago, and the balance under its floor again today.
    await asWorker(on.s.db, scope, (tx) =>
      tx.execute(sql`update app.usage_wallets set floor_cents = balance_cents + 1000, topup_cents = 2_500,
            auto_topup = true, escalation_step = 2, recharges_in_window = 3,
            window_started_at = now() - interval '30 days', last_recharge_at = now() - interval '29 days',
            suspended_at = null, paused_until = null, declines_in_row = 0
          where workspace_id = ${w.workspaceId}`),
    );
    const ladder = async () =>
      (
        await rows<{ step: number; recharges: number; startedHoursAgo: number }>(
          admin(),
          sql`select escalation_step as step, recharges_in_window as recharges,
                round(extract(epoch from now() - window_started_at) / 3600)::int as "startedHoursAgo"
              from app.usage_wallets where workspace_id = ${w.workspaceId}`,
        )
      )[0];
    // The billing page says nothing about a run that has ended.
    const page = async () => (await query(w, walletGet, { workspaceId: w.workspaceId })).escalation;
    expect(await page()).toBeNull();
    const sweep = () =>
      sweepWallet({
        ...on.s,
        job: { payload: {} } as unknown as JobContext['job'],
        scope,
        attempt: 1,
        now: Date.now(),
      });

    // The first top-up after the quiet spell is their own amount, and starts a new run.
    const before = charges().length;
    await sweep();
    await drain(on);
    expect(
      charges()
        .slice(before)
        .map((c) => c.amountCents),
    ).toEqual([2_500]);
    expect(await ladder()).toEqual({ step: 0, recharges: 1, startedHoursAgo: 0 });

    // Ten hours on (not a rush), it runs low again: the second top-up of this run doubles.
    await asWorker(on.s.db, scope, (tx) =>
      tx.execute(sql`update app.usage_wallets set floor_cents = balance_cents + 1000,
            window_started_at = window_started_at - interval '10 hours',
            last_recharge_at = last_recharge_at - interval '10 hours'
          where workspace_id = ${w.workspaceId}`),
    );
    await sweep();
    await drain(on);
    expect(
      charges()
        .slice(before)
        .map((c) => c.amountCents),
    ).toEqual([2_500, 5_000]);
    // Still the run that began ten hours ago, now at two top-ups.
    expect(await ladder()).toEqual({ step: 1, recharges: 2, startedHoursAgo: 10 });
    expect(await page()).toContain('topped up 2 times in the last three days');
  });
});
