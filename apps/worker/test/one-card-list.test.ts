/**
 * One list of cards for the plan and the usage balance (20261027023600, the owner's 5a of 2026-11-08), in the worker
 * against the payments stand-in:
 *
 * - a card put on the balance (the phone's Balance) joins the list as the default, and a card added to the list
 *   (Settings → Billing & Usage) is a backup unless it's made the default;
 * - the default is the balance's card, so making another the default moves the balance onto it;
 * - a declined top-up tries the backups in turn, and keeps the decline on the card that said no;
 * - the balance's Remove card only takes the business's one card off; with more, the list is changed on the web;
 * - the last card comes off when nothing renews on it, and the balance loses it too.
 */
import {
  billingRemoveCard,
  billingSetDefaultCard,
  walletForgetCard,
  walletTopUp,
} from '@hfos/core/server';
import { rows, sql } from '@hfos/db/client';
import { closeTestDbs, signInTestUser } from '@hfos/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_CARDS } from '../src/payments/fake';
import { admin, drain, moneyWorld, run, type MoneyWorld } from './money-world';

let w: MoneyWorld;
/** The same world with the wallet on, as `WALLET_MODE=on` runs it. */
let on: MoneyWorld;
let ownerToken: string;

/** A card typed on the stand-in's page, through the route a page uses: the balance's, or the list's. */
async function typeCard(
  route: '/v1/wallet/card' | '/v1/plan/card',
  instrument: string,
  extra: Record<string, unknown> = {},
) {
  const call = (body: Record<string, unknown> = {}) =>
    w.app.inject({
      method: 'POST',
      url: route,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { workspaceId: w.workspaceId, ...extra, ...body },
    });
  const page = new URL(((await call()).json() as { hostedUrl: string }).hostedUrl);
  const sessionRef = page.searchParams.get('session')!;
  await w.app.inject({
    method: 'POST',
    url: '/payments/fake/card',
    payload: {
      session: sessionRef,
      return: page.searchParams.get('return'),
      instrument,
      decision: 'save',
    },
  });
  const back = await call({ sessionRef });
  expect(back.statusCode).toBe(200);
}

const cards = () =>
  rows<{
    id: string;
    card_ref: string;
    is_default: boolean;
    last_declined_at: string | null;
  }>(
    admin(),
    sql`select id, card_ref, is_default, last_declined_at::text as last_declined_at
        from app.plan_cards where workspace_id = ${w.workspaceId} order by created_at, id`,
  );

const walletCard = async () =>
  (
    await rows<{
      method_token: string | null;
      card_last4: string | null;
      auto_topup: boolean;
      declines_in_row: number;
    }>(
      admin(),
      sql`select method_token, card_last4, auto_topup, declines_in_row
          from app.usage_wallets where workspace_id = ${w.workspaceId}`,
    )
  )[0]!;

const topUps = () =>
  rows<{ status: string; amount_cents: number }>(
    admin(),
    sql`select status::text as status, amount_cents::int as amount_cents
        from app.wallet_recharges where workspace_id = ${w.workspaceId} order by created_at`,
  );

const charges = () =>
  w.s.payments.fake.platformCharges().filter((c) => c.metadata['workspace_id'] === w.workspaceId);

beforeAll(async () => {
  w = await moneyWorld('one-card-list');
  on = { ...w, s: { ...w.s, wallet: { ...w.s.wallet, mode: 'on' } } };
  ownerToken = await signInTestUser(w.owner);
}, 120_000);

afterAll(async () => {
  await w?.app.close();
  await closeTestDbs();
});

describe('one list of cards for the plan and the balance', () => {
  it('puts the balance’s card on the list as the default, and a new card behind it as a backup', async () => {
    await typeCard('/v1/wallet/card', FAKE_CARDS.succeeds);
    const [first] = await cards();
    expect(first).toMatchObject({ is_default: true });
    expect((await walletCard()).method_token).toBe(first!.card_ref);

    await typeCard('/v1/plan/card', FAKE_CARDS.disputes);
    const after = await cards();
    expect(after.map((c) => c.is_default)).toEqual([true, false]);
    // A backup doesn't touch the balance.
    expect((await walletCard()).method_token).toBe(first!.card_ref);
  });

  it('moves the balance onto whichever card is made the default', async () => {
    const [, backup] = await cards();
    await run(w, billingSetDefaultCard, { workspaceId: w.workspaceId, cardId: backup!.id });
    expect((await walletCard()).method_token).toBe(backup!.card_ref);
    expect((await cards()).find((c) => c.is_default)?.id).toBe(backup!.id);
  });

  it('won’t take the balance’s card off on its own while the business has others', async () => {
    await expect(run(w, walletForgetCard, { workspaceId: w.workspaceId })).rejects.toMatchObject({
      rule: 'wallet_card_has_backups',
    });
  });

  it('tries the backups when a top-up is declined, and keeps the decline on the card', async () => {
    // A new default that's refused whenever it's charged without the customer there.
    await typeCard('/v1/plan/card', FAKE_CARDS.failsOffSession, { makeDefault: true });
    const list = await cards();
    const failing = list.find((c) => c.is_default)!;
    expect((await walletCard()).method_token).toBe(failing.card_ref);

    const before = charges().length;
    await run(w, walletTopUp, { workspaceId: w.workspaceId, amountCents: 2_500 });
    await drain(on);
    expect((await topUps()).at(-1)).toMatchObject({ status: 'succeeded', amount_cents: 2_500 });
    // The default first, then the oldest backup, which paid.
    expect(
      charges()
        .slice(before)
        .map((c) => c.status),
    ).toEqual(['failed', 'succeeded']);
    const now = await cards();
    expect(now.find((c) => c.id === failing.id)?.last_declined_at).not.toBeNull();
    expect(now[0]!.last_declined_at).toBeNull();
    // A backup paying is a top-up that went through: the decline ladder doesn't move.
    expect((await walletCard()).declines_in_row).toBe(0);
  });

  it('takes the last card off when nothing renews on it, and the balance loses it too', async () => {
    const list = await cards();
    for (const c of list.filter((c) => !c.is_default))
      await run(w, billingRemoveCard, { workspaceId: w.workspaceId, cardId: c.id });
    const [last] = await cards();
    expect(last).toMatchObject({ is_default: true });
    await run(w, billingRemoveCard, { workspaceId: w.workspaceId, cardId: last!.id });
    expect(await cards()).toEqual([]);
    expect(await walletCard()).toMatchObject({
      method_token: null,
      card_last4: null,
      auto_topup: false,
    });
  });

  it('lets the balance’s Remove card take the one card off', async () => {
    await typeCard('/v1/wallet/card', FAKE_CARDS.succeeds);
    expect(await cards()).toHaveLength(1);
    await run(w, walletForgetCard, { workspaceId: w.workspaceId });
    expect(await cards()).toEqual([]);
    expect((await walletCard()).method_token).toBeNull();
  });
});
