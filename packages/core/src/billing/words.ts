/**
 * What Settings → Billing and the failed-payment page say (20261027023600), once, for the web and the phone. Plain
 * words, curly apostrophes, and the fix named where there is one.
 */
import { formatUtcDate } from '../crm/format';
import { money } from '../money/format';

const day = (iso: string | null | undefined): string => (iso ? formatUtcDate(new Date(iso)) : '—');

/** "Visa ending 4242", or "The card you paid with" for one whose details Stripe hasn't told us yet. */
export function planCardName(card: {
  readonly brand: string | null;
  readonly last4: string | null;
}): string {
  if (!card.last4) return 'The card you paid with';
  return `${card.brand ?? 'Card'} ending ${card.last4}`;
}

/** "Expires 12/2028", or nothing. */
export function planCardExpiry(card: {
  readonly expiryMonth: number | null;
  readonly expiryYear: number | null;
}): string {
  if (!card.expiryMonth || !card.expiryYear) return '';
  return `Expires ${String(card.expiryMonth).padStart(2, '0')}/${card.expiryYear}`;
}

export const BILLING_WORDS = {
  pageTitle: 'Billing',
  pageBlurb:
    'What you pay HandsFreeOS for your plan, and the cards it’s paid with. Texts, calls and AI are on Usage & balance.',
  noPlan:
    'This business has no plan that’s paid by card, so there’s nothing to bill here. Texts, calls and AI are on Usage & balance.',

  // ---- cards ----
  cardsTitle: 'Cards',
  cardsBlurb:
    'Your default card is charged first. If it’s declined, your backup cards are tried in order.',
  noCards: 'No card yet. Add one so your plan can renew.',
  defaultBadge: 'Default',
  backupBadge: (n: number) => `Backup ${n}`,
  declined: (iso: string, why: string | null) =>
    `Declined ${day(iso)}${why ? `: ${why.replace(/\.$/, '')}` : ''}.`,
  addCard: 'Add a card',
  addingCard: 'Opening the card page…',
  makeDefault: 'Make default',
  remove: 'Remove',
  removeTitle: (name: string) => `Remove ${name}?`,
  removeBody: 'It won’t be charged again. You can add it back any time.',
  removeConfirm: 'Remove card',
  cardAdded: (name: string) => `${name} added.`,
  cardAddedDefault: (name: string) => `${name} added, and it’s your default card now.`,
  cardCancelled: 'No card was added.',

  // ---- the payment day ----
  payDayTitle: 'Payment date',
  payDayLine: (iso: string, cents: number) =>
    `Your next payment is ${money(cents)} on ${day(iso)}.`,
  payDayCredit: (cents: number) =>
    `${money(cents)} is taken off it, for the days you gave up when you moved your payment date.`,
  payDayChange: 'Change date',
  payDayPick: 'New payment date',
  payDayLater: (days: number, cents: number, iso: string) =>
    `That adds ${days} ${days === 1 ? 'day' : 'days'}. You pay ${money(cents)} now for them, then your plan renews on ${day(iso)}.`,
  payDayEarlier: (days: number, cents: number, iso: string, next: number) =>
    `That’s ${days} ${days === 1 ? 'day' : 'days'} sooner, so ${money(cents)} comes off. Your next payment is ${money(next)} on ${day(iso)}.`,
  payDayConfirmLater: (cents: number) => `Pay ${money(cents)} and change date`,
  payDayConfirmEarlier: 'Change date',
  payDayCharging: 'Charging your card…',
  payDayMoved: (iso: string) => `Done. Your plan renews on ${day(iso)} from now on.`,
  payDayFailed: (why: string) =>
    `Your payment date didn’t change, because the charge didn’t go through: ${why} Try another card, or pick another date.`,
  payDayLimits: (earliest: string, latest: string) =>
    `Pick a day from ${day(earliest)} to ${day(latest)}.`,

  // ---- stopping ----
  stopTitle: 'Stop renewing',

  // ---- money owed ----
  owedTitle: 'Your payment didn’t go through',
  owedLine: (cents: number, iso: string) =>
    `We couldn’t take your ${money(cents)} payment on ${day(iso)}.`,
  owedWhy: (why: string) => `Your bank said: ${why}`,
  owedRetry: (iso: string) => `We’ll try your cards again on its own on ${day(iso)}.`,
  owedNoMoreRetries: 'We’ve stopped trying your cards on our own. Pay now, or add another card.',
  payNow: 'Try my cards now',
  payingNow: 'Trying your cards…',
  paidNow: 'Paid. Thank you! Everything’s open again.',
  stillDeclined: (why: string) =>
    `That didn’t go through either: ${why} Add another card, or ask for more time.`,
  addCardAndPay: 'Add a card and pay',
  manageCards: 'Manage cards',

  // ---- the failed-payment page ----
  blockTitle: 'Your HandsFreeOS payment didn’t go through',
  blockSkipHint: (lockedAt: string) =>
    `You can skip this for now, but from ${day(lockedAt)} you’ll need to pay before you can open HandsFreeOS.`,
  blockLocked:
    'HandsFreeOS stays closed until the payment goes through, or until we give you more time.',
  blockNotManager: (who: string | null) =>
    who
      ? `Only someone who manages billing can fix this. Ask ${who} to update the card in Settings → Billing.`
      : 'Only someone who manages billing can fix this. Ask an owner of this business to update the card in Settings → Billing.',
  skip: 'Skip for now',
  skipUntil: (iso: string) => `Skipped until ${day(iso)}.`,
  phoneFix:
    'Open HandsFreeOS on the web to pay, add a card, or ask for more time. Billing can only be changed there.',

  // ---- more time ----
  moreTime: 'Ask for more time',
  moreTimeTitle: 'Ask for more time',
  moreTimeBlurb:
    'Tell us the day you think you can pay by. Someone from HandsFreeOS reads every request and will let you know.',
  moreTimeDate: 'I can pay by',
  moreTimeNote: 'Anything we should know (optional)',
  moreTimeSend: 'Send request',
  moreTimeSending: 'Sending…',
  moreTimeSent: (iso: string) =>
    `Request sent. You asked to pay by ${day(iso)}. We’ll email you when it’s answered.`,
  moreTimeWaiting: (iso: string) =>
    `You asked for more time, until ${day(iso)}. We’ll let you know soon.`,
  moreTimeGranted: (iso: string) =>
    `You have until ${day(iso)} to pay. We’ll try your cards again that day.`,
  moreTimeDeclined:
    'We couldn’t give you more time this time. Please pay now, or add another card.',
  moreTimeLimits: (earliest: string, latest: string) =>
    `Pick a day from ${day(earliest)} to ${day(latest)}.`,
  ticketSubject: (business: string) => `More time to pay, for ${business}`,
  ticketBody: (p: {
    business: string;
    payBy: string;
    amountCents: number;
    problem: string | null;
    note: string;
  }) =>
    [
      `${p.business} asked for more time to pay their HandsFreeOS plan.`,
      '',
      `They think they can pay by: ${formatUtcDate(new Date(`${p.payBy}T12:00:00Z`))}`,
      `Owed: ${money(p.amountCents)}`,
      p.problem ? `Why it failed: ${p.problem}` : null,
      '',
      p.note ? `Their note: ${p.note}` : 'They left no note.',
      '',
      'Give them more time, or say no, from their page in Admin → Businesses.',
    ]
      .filter((l) => l !== null)
      .join('\n'),

  // ---- the phone ----
  phoneBilling: 'Billing is changed on the web: Settings → Billing.',
} as const;
