/**
 * What a business reads about its own balance — the usage wallet — in one browser-safe place, so the web's
 * Settings → Usage & balance and the phone's Balance screen say the same thing about the same number.
 *
 * The wording is deliberately in words before numbers: a business glancing at a balance wants to know whether it
 * is fine, not to do arithmetic. `balanceHeadline` is that sentence, and the number sits underneath it.
 *
 * Nothing here knows what anything cost us. The statement says what was charged and what it was for; the markup
 * stays in the database, where `queries/wallet.ts` explains why.
 */
import { money } from './format';

/** The smallest top-up the commands accept (`WalletTopUpInput`), so a page can say so before the API does. */
export const MIN_TOPUP_CENTS = 500;

/** `wallet.get`'s answer, narrowed to what these words actually read. */
export interface WalletShown {
  /** False for a business that has never spent anything: "nothing yet", not "empty". */
  readonly opened: boolean;
  readonly balanceCents: number;
  readonly autoTopup: boolean;
  readonly floorCents: number;
  readonly card: unknown | null;
  readonly suspended: { readonly reason: string | null } | null;
}

/** How the balance is read: fine, worth a glance, or stopped. */
export type BalanceTone = 'ok' | 'warn' | 'bad';

export interface BalanceHeadline {
  readonly headline: string;
  readonly tone: BalanceTone;
}

/**
 * The sentence over the number. A balance under the floor with a card and automatic top-up on is not a worry —
 * it is a charge on its way — so it reads as fine; the same balance with nothing to charge does not.
 */
export function balanceHeadline(w: WalletShown): BalanceHeadline {
  if (w.suspended) return { headline: 'Texts and calls have stopped', tone: 'bad' };
  if (!w.opened) return { headline: 'Nothing used yet', tone: 'ok' };
  if (w.balanceCents <= 0) return { headline: 'Your balance has run out', tone: 'bad' };
  if (w.balanceCents <= w.floorCents)
    return {
      headline: w.autoTopup && w.card ? 'Topping up shortly' : 'Running low',
      tone: w.autoTopup && w.card ? 'ok' : 'warn',
    };
  return { headline: 'You’re fine', tone: 'ok' };
}

/** "Visa ending 4242 · expires 04/28", or "Card ending ••••" where the provider told us less. */
export function cardLine(card: {
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expiryMonth: number | null;
  readonly expiryYear: number | null;
}): string {
  const head = `${card.brand ?? 'Card'} ending ${card.last4 ?? '••••'}`;
  if (!card.expiryMonth || !card.expiryYear) return head;
  return `${head} · expires ${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}`;
}

/**
 * The cap the terms promise, in the sentence that also says the one setting that stops the escalation. The number
 * is the cap that actually applies to this business today, not the headline one — `wallet.get` works it out.
 */
export const topUpCapLine = (maxTopupCents: number): string =>
  `If several top-ups are needed in a few days we raise the amount each time, so it is one larger charge instead ` +
  `of many small ones — never more than ${money(maxTopupCents)} at once. We email you before charging more than ` +
  `twice your amount above, and raising that amount stops it happening.`;

/**
 * The words on both pages. The phone's variants are named `phone…` where a phone says it shorter, as
 * `DELETE_ACCOUNT_WORDS` does — the same page, in the room it has.
 */
export const BALANCE_WORDS = {
  title: 'Usage & balance',
  /** The phone's top bar, where "Usage & balance" would wrap. */
  phoneTitle: 'Balance',
  phoneSettingsDetail: 'What texts, calls and AI replies come out of',

  balance: 'Your balance',
  balanceDetail:
    'What texts, calls, phone numbers and AI replies come out of. Your plan is billed separately.',
  thisMonth: (cents: number) => `${money(cents)} this month`,
  last30: (cents: number) => `${money(cents)} in the last 30 days`,
  onItsWay: (cents: number) => `${money(cents)} on its way`,
  suspendedFallback: 'The card on this balance was declined.',
  suspendedTail: 'Add a working card and everything starts again.',

  topUp: 'Top up now',
  toppingUp: 'Topping up now.',
  /** A phone charges a card on one tap, so it asks first. The web's button sits under a heading and does not. */
  topUpAsk: (amountCents: number, card: string) => `Charge ${money(amountCents)} to ${card}?`,
  topUpAskTitle: 'Top up now',
  topUpConfirm: (amountCents: number) => `Charge ${money(amountCents)}`,
  keep: 'Not now',

  autoTitle: 'Automatic top-up',
  autoDetail: 'When the balance gets low, we charge the card on file so nothing stops.',
  autoSwitch: 'Top up automatically',
  autoOn: 'Automatic top-up is on.',
  autoOff: 'Automatic top-up is off.',
  floorLabel: 'Top up when it drops below',
  amountLabel: 'Add this much',
  saved: 'Saved.',
  save: 'Save',
  cancel: 'Cancel',
  amountRefused: 'Type an amount, like 25.',
  /** A business may set any floor it likes; the top-up itself has a floor of its own (`WalletTopUpInput`). */
  amountTooSmall: `The smallest top-up is ${money(MIN_TOPUP_CENTS)}.`,
  autoNeedsCard: 'Add a card below and automatic top-up will start working.',

  cardTitle: 'Card on file',
  cardDetail: 'Only ever used for your own balance — never for money your customers pay you.',
  cardWaiting: 'Waiting for a card to be added.',
  cardNone: 'No card on this balance yet.',
  /** Card numbers are typed on the payment page the web opens, never in the app. */
  cardOnWeb: 'Add a card on the web',
  cardOnWebNote: 'Card numbers are typed on our payment page, never in the app.',
  removeCard: 'Remove card',
  removeCardTitle: 'Remove the card?',
  removeCardAsk:
    'Automatic top-up goes off with it, and the balance simply runs down until a card is added again.',
  cardRemoved: 'Card removed. Automatic top-up is off.',

  pricesTitle: 'What things cost',
  pricesDetail: 'The prices on your account today.',

  statementTitle: 'Statement',
  statementDetail: 'Every text, call, number and AI reply you’ve been charged for.',
  statementEmpty: 'Nothing yet. Texts, calls and AI replies show up here as they happen.',
  statementMore: 'Show more',
  /** A spreadsheet of the statement is the web's: a phone has nowhere useful to put a file. */
  statementCsvOnWeb: 'The spreadsheet of this statement is on the web.',
  columnWhat: 'What',
  columnAmount: 'Amount',
  columnBalance: 'Balance',
  usage: 'Usage',

  /** Nothing on this screen is in the phone's copy: the balance is live or it is nothing. */
  needsSignal: 'Your balance needs a signal. Try again when you’re back on.',
  retry: 'Try again',
  loading: 'Getting your balance…',
  /** A member may see the balance and may not spend the business's money (`money.manage`). */
  memberNote: 'Only an owner or an admin can top up or change the card.',
} as const;
