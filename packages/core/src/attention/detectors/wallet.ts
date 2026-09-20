/**
 * The usage wallet's three cards (M16, step 7): the balance running low, the balance empty, and a card that
 * stopped working.
 *
 * These are unlike every other kind here, and the differences are deliberate:
 *
 * - **They are not about a customer.** There is no lead, no person, no conversation, and therefore no money at
 *   stake in the Action Center's sense. `value` is zero so Home's "$ affected" is not inflated by a balance —
 *   the number there is what customers owe, and a wallet is the other direction entirely.
 * - **HandsFreeOS cannot handle them for you.** Every other kind offers "let HandsFreeOS handle it"; here that
 *   would mean charging the card again, which is precisely what already failed.
 * - **Two of them cannot be dismissed.** A business that cannot send a text is not helped by hiding the card
 *   that says so.
 *
 * One card at a time: `wallet_empty` supersedes `wallet_low`, and a declined card supersedes both, because a
 * business staring at three cards about the same thing learns nothing from the second and third.
 */
import { chip } from '../chips';
import { fingerprintOf } from '../fingerprint';
import type { AttentionSettings } from '../settings';
import { defineDetector, detection, stamp, type Assessment } from './define';

/** A wallet has no customer and no job behind it, so it carries no money into Home's totals. */
const NO_VALUE = { value: 0, valueIsEstimate: false, moneyKey: null } as const;

export interface WalletFacts {
  readonly wallet: {
    readonly workspaceId: string;
    readonly balanceCents: number;
    readonly floorCents: number;
    readonly autoTopup: boolean;
    readonly hasCard: boolean;
    /** When it went under its floor and stayed under, from the wallet's own warning state. */
    readonly lowSince: string | null;
    readonly suspendedAt: string | null;
    readonly suspendedReason: string | null;
    readonly declinesInRow: number;
    /** What the last top-up's failure said, in the provider's own words. */
    readonly lastFailureMessage: string | null;
  };
}

/** How a balance reads on the card: "$4.20 left". */
const left = (cents: number): string =>
  cents < 0 ? `$${(Math.abs(cents) / 100).toFixed(2)} over` : `$${(cents / 100).toFixed(2)} left`;

// ---------- the card stopped working ----------

function assessDeclined(f: WalletFacts, _settings: AttentionSettings, _now: number): Assessment {
  const w = f.wallet;
  if (!w.suspendedAt) return null;
  const since = Date.parse(w.suspendedAt);
  return detection({
    fingerprint: fingerprintOf('wallet_card_declined', {
      workspace: w.workspaceId,
      at: stamp(since),
    }),
    since,
    // Urgent from the moment it happens: nothing the business sends will go out until it is fixed.
    urgentFrom: since,
    dueAt: null,
    value: NO_VALUE,
    probability: 1,
    confidence: 1,
    reasons: [
      chip('overdue', w.suspendedReason ?? w.lastFailureMessage ?? 'That card was declined.'),
      chip('no_contact', left(w.balanceCents)),
    ],
    assignee: null,
    recheckAt: null,
  });
}

// ---------- the balance is empty ----------

function assessEmpty(f: WalletFacts, _settings: AttentionSettings, now: number): Assessment {
  const w = f.wallet;
  // A declined card is the same problem with a cause, and says so better. One card, not two.
  if (w.suspendedAt) return null;
  if (w.balanceCents > 0) return null;
  const since = w.lowSince ? Date.parse(w.lowSince) : now;
  return detection({
    fingerprint: fingerprintOf('wallet_empty', { workspace: w.workspaceId }),
    since,
    urgentFrom: since,
    dueAt: null,
    value: NO_VALUE,
    probability: 1,
    confidence: 1,
    reasons: [
      chip('overdue', left(w.balanceCents)),
      chip(
        'no_next_action',
        w.hasCard
          ? w.autoTopup
            ? 'Automatic top-up has not covered it'
            : 'Automatic top-up is off'
          : 'No card on file',
      ),
    ],
    assignee: null,
    recheckAt: null,
  });
}

// ---------- the balance is running low ----------

function assessLow(f: WalletFacts, _settings: AttentionSettings, now: number): Assessment {
  const w = f.wallet;
  if (w.suspendedAt) return null;
  // Empty is its own card, and a harder one.
  if (w.balanceCents <= 0) return null;
  if (w.balanceCents > w.floorCents) return null;
  /**
   * A wallet with a working card and automatic top-up on is about to fix itself, so saying anything would be
   * crying wolf about something that resolves in seconds. The card is for a business that has to act: no card,
   * or automatic top-up switched off.
   */
  if (w.autoTopup && w.hasCard) return null;
  const since = w.lowSince ? Date.parse(w.lowSince) : now;
  return detection({
    fingerprint: fingerprintOf('wallet_low', { workspace: w.workspaceId }),
    since,
    // Not urgent: there is still money, and the whole point of a floor is that it comes before the trouble.
    urgentFrom: null,
    dueAt: null,
    value: NO_VALUE,
    probability: 0.9,
    confidence: 1,
    reasons: [
      chip('waiting', left(w.balanceCents)),
      chip('no_next_action', w.hasCard ? 'Automatic top-up is off' : 'No card on file'),
    ],
    assignee: null,
    recheckAt: null,
  });
}

export const walletLow = defineDetector<WalletFacts>('wallet_low', assessLow);
export const walletEmpty = defineDetector<WalletFacts>('wallet_empty', assessEmpty);
export const walletCardDeclined = defineDetector<WalletFacts>(
  'wallet_card_declined',
  assessDeclined,
);
