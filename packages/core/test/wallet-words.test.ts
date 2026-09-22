/**
 * The words a business reads about its own balance, shared by the web's Settings → Usage & balance and the phone's
 * Balance screen. What matters here is the sentence over the number: a balance under the floor with a card behind it
 * is not a worry, and the same balance with nothing to charge is — so the two must not read alike.
 */
import { describe, expect, it } from 'vitest';
import { attentionTargetOf } from '../src/attention/home-words';
import {
  balanceHeadline,
  cardLine,
  MIN_TOPUP_CENTS,
  topUpCapLine,
  type WalletShown,
} from '../src/money/wallet-words';

const CARD = { brand: 'Visa', last4: '4242', expiryMonth: 4, expiryYear: 2028 };

const wallet = (over: Partial<WalletShown> = {}): WalletShown => ({
  opened: true,
  balanceCents: 4200,
  autoTopup: true,
  floorCents: 1000,
  card: CARD,
  suspended: null,
  ...over,
});

describe('the sentence over the balance', () => {
  it('is nothing to do while there is plenty', () => {
    expect(balanceHeadline(wallet())).toEqual({ headline: 'You’re fine', tone: 'ok' });
  });

  it('says nothing has been used rather than that the balance is empty', () => {
    expect(balanceHeadline(wallet({ opened: false, balanceCents: 0 }))).toEqual({
      headline: 'Nothing used yet',
      tone: 'ok',
    });
  });

  it('reads a low balance as a charge on its way, or as a worry, by what is behind it', () => {
    const low = { balanceCents: 500 };
    expect(balanceHeadline(wallet(low))).toEqual({ headline: 'Topping up shortly', tone: 'ok' });
    // Automatic top-up off, or no card to charge: the same number, and now it needs somebody.
    expect(balanceHeadline(wallet({ ...low, autoTopup: false }))).toEqual({
      headline: 'Running low',
      tone: 'warn',
    });
    expect(balanceHeadline(wallet({ ...low, card: null }))).toEqual({
      headline: 'Running low',
      tone: 'warn',
    });
  });

  it('says what has actually stopped before it says the balance is empty', () => {
    expect(balanceHeadline(wallet({ balanceCents: 0 }))).toEqual({
      headline: 'Your balance has run out',
      tone: 'bad',
    });
    // Suspended wins: the texts and calls have stopped, which is the thing to know.
    expect(balanceHeadline(wallet({ suspended: { reason: 'The card was declined.' } }))).toEqual({
      headline: 'Texts and calls have stopped',
      tone: 'bad',
    });
  });
});

describe('the card and the cap', () => {
  it('writes the card the way a statement does, and copes with a provider that said less', () => {
    expect(cardLine(CARD)).toBe('Visa ending 4242 · expires 04/28');
    expect(cardLine({ brand: null, last4: null, expiryMonth: null, expiryYear: null })).toBe(
      'Card ending ••••',
    );
  });

  it('shows the cap that actually applies, as the terms promise', () => {
    expect(topUpCapLine(20_000)).toContain('never more than $200 at once');
  });

  it('knows the smallest top-up the commands accept', () => {
    expect(MIN_TOPUP_CENTS).toBe(500);
  });
});

describe('where a balance card opens', () => {
  const ws = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const item = (kind: 'wallet_low' | 'wallet_empty' | 'wallet_card_declined') => ({
    kind,
    leadId: null,
    conversationId: null,
    appointmentId: null,
    reasons: [],
    subject: { id: ws, type: 'workspace' as const, name: 'Lone Star HVAC' },
    personId: null,
  });

  it('opens the balance itself, not the customer it has nothing to do with', () => {
    for (const kind of ['wallet_low', 'wallet_empty', 'wallet_card_declined'] as const)
      expect(attentionTargetOf(item(kind), ws)).toEqual({
        href: `/app/w/${ws}/settings/usage`,
        label: 'Open your balance',
      });
  });
});
