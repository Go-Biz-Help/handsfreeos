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
  type WalletStage,
} from '../src/money/wallet-gate';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

interface WalletShape {
  balance_cents: number;
  overdraft_cents: number;
  stage: WalletStage;
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

const at =
  (stage: WalletStage) =>
  (balance: number, overdraft = 1000): WalletShape => ({
    balance_cents: balance,
    overdraft_cents: overdraft,
    stage,
  });
const enforced = at('enforce');
const warned = at('warn');
const silent = at('off');

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

  it('lets a text out even when the wallet is broken and the business is meant to be enforcing', async () => {
    // There is no way to tell these apart from outside, which is the point: an unreadable wallet is allowed.
    await expect(assertWalletHasRoom(brokenTx(), WORKSPACE, 'text')).resolves.toBeUndefined();
  });
});

describe('walletRoom before a business has been moved along', () => {
  it('allows a business with no wallet row — it has never spent anything', async () => {
    const room = await walletRoom(txWith(null), WORKSPACE, 'text');
    expect(room).toEqual({
      allowed: true,
      balanceCents: 0,
      overdraftCents: 0,
      unknown: false,
      stage: 'off',
    });
  });

  it('allows a business deep in the red at `off` — which is every business during a shadow week', async () => {
    // This is the case the shadow week actually produces: nobody has a card, every balance goes negative,
    // and not one text may be refused over it.
    const room = await walletRoom(txWith(silent(-50_000)), WORKSPACE, 'text');
    expect(room).toMatchObject({ allowed: true, stage: 'off', unknown: false });
  });

  it('allows a business deep in the red at `warn` — being told is not being stopped', async () => {
    const room = await walletRoom(txWith(warned(-50_000)), WORKSPACE, 'text');
    expect(room).toMatchObject({ allowed: true, stage: 'warn' });
  });

  it('reads an unrecognised stage as `off`, because that fails open like everything else here', async () => {
    const room = await walletRoom(
      txWith({ balance_cents: -50_000, overdraft_cents: 0, stage: 'enforcing' as WalletStage }),
      WORKSPACE,
      'text',
    );
    expect(room).toMatchObject({ allowed: true, stage: 'off' });
  });
});

describe('walletRoom once a business is at `enforce`', () => {
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
    stage: 'enforce',
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

  /*
   * The cases above all set `stage: 'enforce'` with an overdraft, and that is exactly how this shipped
   * broken: without the stage clause this read `balanceCents > -overdraftCents`, and a business with no
   * wallet at all — which is every business while `WALLET_MODE` is `off` — is balance 0, overdraft 0.
   * `0 > -0` is false, so every inbound call went to voicemail and nobody's phone rang. Five tests passed.
   *
   * So these start from what `walletRoom` actually returns rather than from a hand-made room: the bug was
   * in the gap between the two.
   */
  describe('the stage decides, and these are the rooms a real business has', () => {
    it('rings out for a business with no wallet row at all — the default everywhere today', async () => {
      const real = await walletRoom(txWith(null), WORKSPACE, 'call');
      expect(real).toMatchObject({ balanceCents: 0, overdraftCents: 0, stage: 'off' });
      expect(mayRingOut(real)).toBe(true);
    });

    it('rings out at `off` however deep in the red — a shadow week refuses nobody', async () => {
      expect(mayRingOut(await walletRoom(txWith(silent(-50_000, 0)), WORKSPACE, 'call'))).toBe(
        true,
      );
    });

    it('rings out at `warn`, because warning is not stopping', async () => {
      expect(mayRingOut(await walletRoom(txWith(warned(-50_000, 0)), WORKSPACE, 'call'))).toBe(
        true,
      );
    });

    it('still stops at `enforce` past the overdraft, which is the only case that should', async () => {
      expect(mayRingOut(await walletRoom(txWith(enforced(-50_000, 0)), WORKSPACE, 'call'))).toBe(
        false,
      );
    });
  });
});
