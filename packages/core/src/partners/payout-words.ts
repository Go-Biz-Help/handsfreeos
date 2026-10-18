/**
 * What people read about paying partners (HANDSFREEOS_PARTNERS_IMPLEMENTATION_PLAN.md, stage 3): the business under
 * Settings → Partners and on a partner's page there, and the partner on their own page in the portal. The web and the
 * phone say the same thing.
 *
 * Browser-safe.
 */
import type { PayoutLineStatus, PayoutStatus } from '../schemas/partner-payouts';

const partners = (n: number) => (n === 1 ? '1 partner' : `${n} partners`);

/** A payout's status, as staff read it in a sentence. */
const PAYOUT_STATUS_PLAIN: Record<PayoutStatus, string> = {
  charging: 'Charging the card',
  paying: 'Paying partners',
  paid: 'Paid',
  failed: 'Not charged',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "November 2026", for a month given as its first day ("2026-11-01"). */
export function payoutMonthWords(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return y && m ? `${MONTHS[m - 1] ?? ''} ${y}` : month;
}

export const PAYOUT_WORDS = {
  // ---------- the business, under Settings → Partners ----------
  title: 'Paying your partners',
  about:
    'Once a month, HandsFreeOS adds up what your partners are owed for payments at least 30 days old, charges your card for it and Stripe’s fees, and pays each partner to their bank through Stripe.',
  notOpen:
    'HandsFreeOS doesn’t pay your partners for you yet. Until it does, pay them yourself from what this page shows they’re owed.',

  card: {
    title: 'Card for partner payouts',
    none: 'No card yet, so your partners aren’t paid. Add one, and the next payout goes out within the hour, then on the first of each month.',
    add: 'Add a card',
    change: 'Change the card',
    remove: 'Take the card off',
    removeTitle: 'Take the card off?',
    removeBody:
      'Your partners aren’t paid until a card is back on. What they’re owed is kept for them.',
    removeKeep: 'Keep the card',
    removed: 'Card taken off. Your partners are paid once a card is back on.',
    saved: (last4: string) => `Card ending ${last4} saved. Partner payouts are charged to it.`,
    ends: (brand: string, last4: string) => `${brand} ending ${last4}`,
    expires: (month: number, year: number) => `Expires ${String(month).padStart(2, '0')}/${year}`,
    needsMoney:
      'Only someone who manages money in this business adds or changes the card. Ask an owner of this business.',
    cancelled: 'No card was added.',
  },

  next: {
    title: 'Next payout',
    soon: 'Within the hour',
    on: (date: string) => `On ${date}`,
    none: 'Nobody’s owed enough to be paid yet.',
    pays: (n: number) => `Pays ${partners(n)}`,
    belowSmallest: (amount: string) =>
      `${amount} waits for next month: less than your smallest payout.`,
    noBank: 'Kept for them until they set up payouts on their page.',
    about:
      'As it stands now. What’s paid is worked out when the payout goes out, so it can change before then.',
  },

  totals: {
    owed: 'Your partners',
    accountFees: 'Stripe’s account fee ($2 for each partner paid)',
    payoutFees: 'Stripe’s payout fee (0.25% + 25¢ for each)',
    cardFee: 'Card fee (2.9% + 30¢)',
    charge: 'Charged to your card',
  },

  history: {
    title: 'Payouts',
    empty: 'No payouts yet.',
    month: (month: string) => `${payoutMonthWords(month)} payout`,
    pays: (n: number) => partners(n),
    test: 'Test: no real money moved',
    open: 'See the statement',
  },

  status: {
    charging: 'Charging your card',
    paying: 'Paying your partners',
    paid: 'Paid',
    failed: 'Not charged',
  } satisfies Record<PayoutStatus, string>,
  statusLine: {
    retry: (date: string, message: string) => `${message} We’ll try your card again ${date}.`,
    failed: (message: string) =>
      `${message} What your partners were owed is paid with next month’s payout.`,
    paying: 'Charged. Your partners are being paid.',
  },

  line: {
    pending: 'On its way',
    paid: (date: string) => `Paid ${date}`,
    held: 'Held: Stripe needs something from them before it can pay them. It’s sent once Stripe can.',
    cancelled: 'In next month’s payout',
    deleted: 'A deleted partner',
  } satisfies Record<PayoutLineStatus, unknown> & { deleted: string },

  /** A partner's page, under Settings → Partners. */
  partner: {
    title: 'Payouts',
    noAccount: 'Hasn’t set up payouts yet. They do it on their page, with Stripe.',
    needsMore:
      'Stripe needs a few more details from them before it can pay them. They finish it on their page.',
    ready: 'Payouts go to their bank through Stripe.',
    empty: 'Nothing paid to them yet.',
  },

  // ---------- staff, on a business's page in /admin ----------
  staff: {
    title: 'Partner payouts',
    explain:
      'Whether HandsFreeOS charges this business’s card each month for what it owes its partners, and pays them through Stripe. One business at a time, once the terms have been checked.',
    open: 'Open',
    closed: 'Closed',
    card: (has: boolean) => (has ? 'A card is on.' : 'No card yet.'),
    payouts: (n: number, latest: PayoutStatus | null) =>
      n === 0
        ? 'No payouts yet.'
        : `${n === 1 ? '1 payout' : `${n} payouts`}; the latest is ${(latest ? PAYOUT_STATUS_PLAIN[latest] : 'unknown').toLowerCase()}.`,
    openIt: 'Open partner payouts',
    closeIt: 'Close partner payouts',
    openTitle: (business: string) => `Open partner payouts for ${business}?`,
    openBody:
      'Within the hour, HandsFreeOS works out what this business owes its partners each month, charges its card once there is one, and pays them through Stripe.',
    closeTitle: (business: string) => `Close partner payouts for ${business}?`,
    closeBody:
      'Nothing more is charged. A payout already charged still pays its partners, and what they’re owed is kept.',
    why: 'Why',
    whyPlaceholder: 'The terms are checked, trying it on our own business first…',
    sayWhy: 'Say why, in a few words.',
    confirm: (open: boolean) => (open ? 'Open them' : 'Close them'),
    cancel: 'Cancel',
  },

  // ---------- the worker's reasons, stored on a payout ----------
  declined: 'Your card was declined.',
  stopped: {
    closed: 'Partner payouts were closed for this business before the card was charged.',
    noCard: 'The card was taken off before it was charged.',
  },
  heldReason: 'Stripe can’t send money to their bank yet.',

  // ---------- the partner, on their own page in the portal ----------
  portal: {
    title: 'Getting paid',
    about: (business: string) =>
      `${business} pays you through Stripe once a month, for shares at least 30 days old. You give your bank and tax details to Stripe, never to us or to ${business}.`,
    setUp: 'Set up payouts',
    setUpHint:
      'It takes a few minutes on Stripe’s own page. Have your bank details and Social Security number to hand.',
    finish: 'Finish with Stripe',
    finishHint: 'Stripe needs a few more details before it can pay you.',
    ready: 'You’re set up. Payouts go to your bank through Stripe.',
    openStripe: 'Open your Stripe page',
    smallest: (amount: string) => `Less than ${amount} waits for the next month.`,
    history: 'Your payouts',
    lineStatus: {
      pending: 'On its way',
      paid: (date: string) => `Paid ${date}`,
      held: 'Stripe needs something from you before it can send this. Open your Stripe page.',
    },
    test: 'Test: no real money moved',
    back: 'Back from Stripe. It can take a minute for Stripe to finish checking your details.',
  },
} as const;
