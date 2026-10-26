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

/**
 * The daily AI limit (20261027012500): the most a business's AI may be charged in a day, which the business sets
 * itself. $10 until it does; a person may set anything from $1 (below that the AI would pause on its first
 * answer) up to the column's own bound, which is a sanity check and not a ceiling HandsFreeOS sets.
 */
export const DEFAULT_AI_DAILY_LIMIT_CENTS = 1000;
export const MIN_AI_DAILY_LIMIT_CENTS = 100;
export const MAX_AI_DAILY_LIMIT_CENTS = 100_000_000;

/**
 * What the AI says when the business's daily AI limit is reached, wherever it stops: what happened, when it
 * comes back, and who can change it where. The amount when it's known; a few paths only know it was reached.
 */
export function aiLimitReached(limitCents?: number | null): string {
  const limit =
    limitCents === undefined || limitCents === null
      ? 'today’s AI limit'
      : `the ${money(limitCents)} daily AI limit`;
  return `This business reached ${limit}, so the AI is paused until midnight. An owner or admin can raise the limit in Settings → Usage & balance.`;
}

/** The daily AI limit's words, on the web's Usage & balance and the phone's Balance screen alike. */
export const AI_LIMIT_WORDS = {
  title: 'Daily AI limit',
  detail:
    'The most your AI can spend in a day: Ask HandsFreeOS, your AI teammate, workflows and add-ons. It stops a runaway from charging you all day. When it’s reached, the AI pauses until midnight.',
  label: 'Pause the AI after',
  perDay: 'a day',
  today: (spentCents: number, limitCents: number) =>
    `${money(spentCents)} of ${money(limitCents)} used today`,
  saved: (limitCents: number) => `The AI can now spend up to ${money(limitCents)} a day.`,
  refused: 'Type an amount, like 10.',
  tooSmall: `The smallest daily AI limit is ${money(MIN_AI_DAILY_LIMIT_CENTS)}.`,
  memberNote: 'Only an owner or an admin can change the daily AI limit.',
} as const;

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

/**
 * How much of something a statement line was for, in words: "3 minutes", "2 segments", "2,340 characters". The
 * ledger keeps the card's own unit (thousands of characters, millions of tokens); a person reads the thing itself.
 */
export function usageQuantityWords(quantity: number, unit: string): string {
  const q = Number.isFinite(quantity) ? quantity : 0;
  const count = (n: number, one: string, many: string) =>
    `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} ${n === 1 ? one : many}`;
  switch (unit) {
    case 'kchar':
      return count(Math.round(q * 1000), 'character', 'characters');
    case 'mtok':
      return count(Math.round(q * 1_000_000), 'token', 'tokens');
    case 'minute':
      return count(Math.round(q * 10) / 10, 'minute', 'minutes');
    case 'month':
      return count(q, 'month', 'months');
    case 'segment':
      return count(q, 'segment', 'segments');
    case 'message':
      return count(q, 'message', 'messages');
    case 'fee':
      return q === 1 ? 'once' : `${q.toLocaleString('en-US')} times`;
    default:
      return `${q} ${unit}`;
  }
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
  addCard: 'Add a card',
  changeCard: 'Use a different card',
  /** What the button does before anything else happens, on both the web and the phone. */
  addingCard: 'Opening the card page…',
  /** The card is typed on the payment provider's own page, and never anywhere of ours. */
  cardOnProvider: 'The card is typed on our payment provider’s own page, never in HandsFreeOS.',
  cardSaved: (card: string) => `${card}. Automatic top-up can run now.`,
  cardNotSaved: 'Nothing was saved, so the balance still has no card.',
  cardSaving: 'Saving the card…',
  /** A phone with nothing to open a web page in: rare, and worth saying rather than failing quietly. */
  noBrowser: 'This phone has no web browser to open the card page in.',
  /** A build that doesn't know where to ask: on the web the same page can still do it. */
  cardOnWebInstead: 'This build can’t add a card. Open Usage & balance on the web instead.',
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
