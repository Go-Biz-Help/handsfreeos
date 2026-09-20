/**
 * The three wallet cards, and the judgements behind them (M16, step 7).
 *
 * The one worth reading first is "does not cry wolf": a balance under its floor, with a working card and
 * automatic top-up on, is about to fix itself in seconds. Showing a card for that teaches a business to ignore
 * the next one, which is the only way the Action Center can actually fail.
 */
import { describe, expect, it } from 'vitest';
import { defaultAttentionSettings } from '../src/attention/settings';
import {
  walletCardDeclined,
  walletEmpty,
  walletLow,
  type WalletFacts,
} from '../src/attention/detectors/wallet';

const NOW = new Date('2026-09-20T12:00:00Z');
const settings = defaultAttentionSettings();

const facts = (over: Partial<WalletFacts['wallet']> = {}): WalletFacts => ({
  wallet: {
    workspaceId: '11111111-1111-1111-1111-111111111111',
    // The existing cases were all written before stages existed, and they are all about a business that is
    // being stopped — so `enforce` is the default here and the `off` / `warn` cases are asked for explicitly.
    stage: 'enforce' as const,
    balanceCents: 5000,
    floorCents: 1000,
    autoTopup: true,
    hasCard: true,
    lowSince: null,
    suspendedAt: null,
    suspendedReason: null,
    declinesInRow: 0,
    lastFailureMessage: null,
    ...over,
  },
});

const low = (over: Partial<WalletFacts['wallet']> = {}) =>
  walletLow.detect(facts(over), settings, NOW);
const empty = (over: Partial<WalletFacts['wallet']> = {}) =>
  walletEmpty.detect(facts(over), settings, NOW);
const declined = (over: Partial<WalletFacts['wallet']> = {}) =>
  walletCardDeclined.detect(facts(over), settings, NOW);

describe('a balance running low', () => {
  /** The one that matters. A wallet that is about to top itself up has nothing for anybody to do. */
  it('does not cry wolf about a wallet that is about to fix itself', () => {
    expect(low({ balanceCents: 500, autoTopup: true, hasCard: true })).toBeNull();
  });

  it('shows when there is something to do: no card, or automatic top-up off', () => {
    expect(low({ balanceCents: 500, hasCard: false })).not.toBeNull();
    expect(low({ balanceCents: 500, autoTopup: false })).not.toBeNull();
  });

  it('says how much is left and what would fix it', () => {
    const d = low({ balanceCents: 420, hasCard: false })!;
    expect(d.reasons.map((r) => r.label)).toEqual(
      expect.arrayContaining(['$4.20 left', 'No card on file']),
    );
  });

  it('is not urgent: there is still money, which is the whole point of a floor', () => {
    expect(low({ balanceCents: 500, hasCard: false })!.urgentFrom).toBeNull();
  });

  it('says nothing while the balance is above the floor', () => {
    expect(low({ balanceCents: 1001, hasCard: false })).toBeNull();
    expect(low({ balanceCents: 1000, hasCard: false })).not.toBeNull();
  });
});

describe('a balance that has run out', () => {
  it('holds at zero and below, whatever the settings say', () => {
    expect(empty({ balanceCents: 0 })).not.toBeNull();
    expect(empty({ balanceCents: -250 })).not.toBeNull();
    expect(empty({ balanceCents: 1 })).toBeNull();
  });

  it('is urgent from the moment it happens', () => {
    const d = empty({ balanceCents: 0 })!;
    expect(d.urgentFrom).not.toBeNull();
  });

  it('says how far under, when it is under', () => {
    expect(empty({ balanceCents: -250 })!.reasons.map((r) => r.label)).toContain('$2.50 over');
  });

  it('says which of the three reasons it ran out', () => {
    expect(empty({ balanceCents: 0, hasCard: false })!.reasons.map((r) => r.label)).toContain(
      'No card on file',
    );
    expect(empty({ balanceCents: 0, autoTopup: false })!.reasons.map((r) => r.label)).toContain(
      'Automatic top-up is off',
    );
    expect(empty({ balanceCents: 0 })!.reasons.map((r) => r.label)).toContain(
      'Automatic top-up has not covered it',
    );
  });
});

describe('a card that stopped working', () => {
  it('carries the provider’s own words about why', () => {
    const d = declined({
      balanceCents: 0,
      suspendedAt: '2026-09-20T09:00:00.000Z',
      suspendedReason: 'That card was reported lost.',
    })!;
    expect(d.reasons.map((r) => r.label)).toContain('That card was reported lost.');
    expect(d.urgentFrom).toBe('2026-09-20T09:00:00.000Z');
  });

  it('holds even while there is still money, because nothing will top it up now', () => {
    expect(
      declined({ balanceCents: 5000, suspendedAt: '2026-09-20T09:00:00.000Z' }),
    ).not.toBeNull();
  });
});

describe('one card at a time', () => {
  /** Three cards about one problem teach nothing after the first. */
  it('stands the other two down when the card was declined', () => {
    const suspended = { balanceCents: -100, suspendedAt: '2026-09-20T09:00:00.000Z' };
    expect(declined(suspended)).not.toBeNull();
    expect(empty(suspended)).toBeNull();
    expect(low(suspended)).toBeNull();
  });

  it('stands "running low" down when the balance has actually run out', () => {
    const gone = { balanceCents: 0, hasCard: false };
    expect(empty(gone)).not.toBeNull();
    expect(low(gone)).toBeNull();
  });
});

describe('what a wallet card is not', () => {
  /** Home's "$ affected" is what customers owe. A balance is the other direction and must not inflate it. */
  it('carries no money into Home’s totals', () => {
    for (const d of [
      low({ balanceCents: 500, hasCard: false }),
      empty({ balanceCents: 0 }),
      declined({ suspendedAt: '2026-09-20T09:00:00.000Z' }),
    ]) {
      expect(d!.value).toBe(0);
      expect(d!.moneyKey).toBeNull();
    }
  });

  it('is never assigned to anybody: a wallet belongs to the business', () => {
    expect(empty({ balanceCents: 0 })!.assignee).toBeNull();
    expect(declined({ suspendedAt: '2026-09-20T09:00:00.000Z' })!.assignee).toBeNull();
  });
});

describe('the settings', () => {
  it('let a business turn off the warning and not the emergencies', () => {
    const off = { ...settings, kinds: { ...settings.kinds, wallet_low: false } };
    expect(walletLow.detect(facts({ balanceCents: 500, hasCard: false }), off, NOW)).toBeNull();
    // `wallet_empty` and `wallet_card_declined` are `z.literal(true)`: there is no false to pass.
    expect(settings.kinds.wallet_empty).toBe(true);
    expect(settings.kinds.wallet_card_declined).toBe(true);
  });
});

/**
 * The stage, which decides whether any of this is said at all.
 *
 * The case that matters is a shadow week: every balance in the system goes negative because nobody has a card
 * and nothing is being charged. If these cards fired on the balance alone, every business would be told its
 * balance had run out and its texts had stopped — neither of which would be true. That is the one way this
 * feature could have done real damage on its first day.
 */
describe('before a business is on the wallet', () => {
  const broke = { balanceCents: -5000, lowSince: '2026-09-19T12:00:00Z' };

  it('says nothing at all at `off`, whatever the balance', () => {
    expect(empty({ ...broke, stage: 'off' })).toBeNull();
    expect(low({ balanceCents: 500, hasCard: false, stage: 'off' })).toBeNull();
    expect(
      declined({ stage: 'off', suspendedAt: '2026-09-19T12:00:00Z', declinesInRow: 3 }),
    ).toBeNull();
  });

  it('speaks at `warn`, but does not call it urgent', () => {
    const card = empty({ ...broke, stage: 'warn' });
    expect(card).not.toBeNull();
    // Nothing has stopped yet, so this is a card to read today, not an emergency. Spending the word here
    // would leave nothing to say on the day it is true.
    expect(card!.urgentFrom).toBeNull();
  });

  it('calls it urgent at `enforce`, because by then it is', () => {
    const card = empty({ ...broke, stage: 'enforce' });
    expect(card!.urgentFrom).toBe(new Date(broke.lowSince).toISOString());
  });
});
