/**
 * The spending gate, and the cases where refusing would be worse than spending (M16, step 9).
 *
 * Most of this file is about the gate *not* firing. That is deliberate: this is the first piece of the wallet
 * that can stop a business's phone working, so the interesting tests are the ones proving it stays out of the
 * way — an unreadable wallet, a business nobody has switched on yet, an inbound call at a negative balance.
 * A gate that over-refuses loses a customer a job; a gate that under-refuses loses us a few cents.
 */
import { describe, expect, it } from 'vitest';
import type { Tx } from '@hfos/db/client';
import { HfosError } from '../src/errors';
import {
  assertWalletHasRoom,
  mayRingOut,
  walletRoom,
  WALLET_REFUSALS,
  type WalletRoom,
} from '../src/money/wallet-gate';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

interface WalletShape {
  balance_cents: number;
  overdraft_cents: number;
  enforced: boolean;
}

/** A transaction that answers the gate's one query, in whichever shape the driver hands back. */
function txWith(row: WalletShape | null, shape: 'rows' | 'array' = 'rows'): Tx {
  const result = row === null ? [] : [row];
  return {
    execute: async () => (shape === 'rows' ? { rows: result } : result),
  } as unknown as Tx;
}

/** A transaction that is having a bad day: a lock timeout, a dropped connection, a table that isn't there. */
function brokenTx(message = 'canceling statement due to lock timeout'): Tx {
  return {
    execute: async () => {
      throw new Error(message);
    },
  } as unknown as Tx;
}

const enforced = (balance: number, overdraft = 1000): WalletShape => ({
  balance_cents: balance,
  overdraft_cents: overdraft,
  enforced: true,
});

describe('walletRoom fails open', () => {
  it('allows the spend when the wallet cannot be read at all', async () => {
    const room = await walletRoom(brokenTx(), WORKSPACE, 'text');
    expect(room).toMatchObject({ allowed: true, unknown: true });
  });

  it('says loudly why, so a database problem is never silent', async () => {
    const said: { message: string; error: unknown }[] = [];
    await walletRoom(
      brokenTx('relation "app.usage_wallets" does not exist'),
      WORKSPACE,
      'text',
      (message, error) => said.push({ message, error }),
    );
    expect(said).toHaveLength(1);
    expect(said[0]!.message).toMatch(/wallet/i);
    expect((said[0]!.error as Error).message).toMatch(/does not exist/);
  });

  it('lets a text out even when the wallet is broken and the business is meant to be enforced', async () => {
    // There is no way to tell these apart from outside, which is the point: an unreadable wallet is allowed.
    await expect(assertWalletHasRoom(brokenTx(), WORKSPACE, 'text')).resolves.toBeUndefined();
  });
});

describe('walletRoom before anybody has been switched on', () => {
  it('allows a business with no wallet row — it has never spent anything', async () => {
    const room = await walletRoom(txWith(null), WORKSPACE, 'text');
    expect(room).toEqual({ allowed: true, balanceCents: 0, overdraftCents: 0, unknown: false });
  });

  it('allows a business at zero while enforcement is off for it', async () => {
    const room = await walletRoom(
      txWith({ balance_cents: 0, overdraft_cents: 0, enforced: false }),
      WORKSPACE,
      'text',
    );
    expect(room).toMatchObject({ allowed: true, balanceCents: 0, unknown: false });
  });

  it('allows a business deep in the red while enforcement is off for it', async () => {
    const room = await walletRoom(
      txWith({ balance_cents: -50_000, overdraft_cents: 1000, enforced: false }),
      WORKSPACE,
      'text',
    );
    expect(room.allowed).toBe(true);
  });
});

describe('walletRoom once a business is enforced', () => {
  it('allows a positive balance', async () => {
    expect((await walletRoom(txWith(enforced(2500)), WORKSPACE, 'text')).allowed).toBe(true);
  });

  it('allows a balance inside the overdraft: the bill for these is already ours', async () => {
    expect((await walletRoom(txWith(enforced(-999)), WORKSPACE, 'text')).allowed).toBe(true);
  });

  it('refuses at the overdraft floor, not a cent past it', async () => {
    expect((await walletRoom(txWith(enforced(-1000)), WORKSPACE, 'text')).allowed).toBe(false);
    expect((await walletRoom(txWith(enforced(-1001)), WORKSPACE, 'call')).allowed).toBe(false);
  });

  it('wants a whole first month before it lets a number be bought', async () => {
    // A text at $0.02 goes through on a balance a phone number's $3.50 first month cannot.
    expect((await walletRoom(txWith(enforced(100, 0)), WORKSPACE, 'text')).allowed).toBe(true);
    expect((await walletRoom(txWith(enforced(100, 0)), WORKSPACE, 'number')).allowed).toBe(false);
    expect((await walletRoom(txWith(enforced(400, 0)), WORKSPACE, 'number')).allowed).toBe(true);
  });

  it('reads the row whichever shape the driver returns', async () => {
    const asRows = await walletRoom(txWith(enforced(-2000), 'rows'), WORKSPACE, 'text');
    const asArray = await walletRoom(txWith(enforced(-2000), 'array'), WORKSPACE, 'text');
    expect(asRows).toEqual(asArray);
    expect(asRows.allowed).toBe(false);
  });
});

describe('assertWalletHasRoom', () => {
  it('says nothing when there is room', async () => {
    await expect(
      assertWalletHasRoom(txWith(enforced(2500)), WORKSPACE, 'text'),
    ).resolves.toBeUndefined();
  });

  it('refuses a text with 402 and words a business can act on', async () => {
    const e = await assertWalletHasRoom(txWith(enforced(-5000)), WORKSPACE, 'text').catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(HfosError);
    const err = e as HfosError;
    expect(err.rule).toBe('wallet_empty');
    expect(err.status).toBe(402);
    expect(err.message).toBe(WALLET_REFUSALS.text);
    // Never a banking phrase, and always a way out.
    expect(err.message).not.toMatch(/insufficient|declined|error/i);
    expect(err.message).toMatch(/top up/i);
  });

  it('gives buying a number its own rule, because the fix is a bigger top-up', async () => {
    const e = (await assertWalletHasRoom(txWith(enforced(100, 0)), WORKSPACE, 'number').catch(
      (x: unknown) => x,
    )) as HfosError;
    expect(e.rule).toBe('wallet_short');
    expect(e.message).toBe(WALLET_REFUSALS.number);
  });

  it('tells the AI it paused rather than that it broke', async () => {
    const e = (await assertWalletHasRoom(txWith(enforced(-5000)), WORKSPACE, 'ai').catch(
      (x: unknown) => x,
    )) as HfosError;
    expect(e.message).toMatch(/paused/i);
  });
});

describe('mayRingOut', () => {
  const room = (over: Partial<WalletRoom>): WalletRoom => ({
    allowed: true,
    balanceCents: 0,
    overdraftCents: 1000,
    unknown: false,
    ...over,
  });

  it('rings out on a healthy balance', () => {
    expect(mayRingOut(room({ balanceCents: 2500 }))).toBe(true);
  });

  it('rings out inside the overdraft', () => {
    expect(mayRingOut(room({ balanceCents: -999 }))).toBe(true);
  });

  it('stops ringing out past the overdraft — voicemail still answers', () => {
    expect(mayRingOut(room({ balanceCents: -1000 }))).toBe(false);
  });

  it('rings out when the wallet could not be read', () => {
    // The same fail-open rule as everything else: an unknown balance never sends a customer to voicemail.
    expect(mayRingOut(room({ balanceCents: -50_000, unknown: true }))).toBe(true);
  });

  it('ignores `allowed`: an inbound call is never hard-blocked, only degraded', () => {
    // A wallet the gate would refuse a text on still rings phones, as long as it is inside the overdraft.
    expect(mayRingOut(room({ allowed: false, balanceCents: -500 }))).toBe(true);
  });
});
