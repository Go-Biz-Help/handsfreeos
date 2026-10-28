/**
 * Paying affiliates (20261027014400, HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 4), said once for the web,
 * the phone and the emails. Browser-safe.
 *
 * Once a month, what's ready is sent to their bank by Stripe (decisions 7 to 10): a Stripe Express account they set
 * up on Stripe's own page, US only, $25 at least, with Stripe's fees paid by HandsFreeOS. Staff turn payouts on once
 * the terms are read; until then they can set up their bank, and what they've earned keeps.
 */
import { money } from '../money/format';

/** The least sent in one payout (decision 9). Less waits for the next month. */
export const AFFILIATE_MIN_PAYOUT_CENTS = 2500;

/** Where their bank at Stripe stands, in one word for the page. */
export type AffiliateBankState = 'none' | 'unfinished' | 'ready' | 'stopped';

/** What Stripe says of their account, as the page says it: none yet, its form not finished, paid, or stopped. */
export function affiliateBankState(
  a: { detailsSubmitted: boolean; payoutsEnabled: boolean; transfersActive: boolean } | null,
): AffiliateBankState {
  if (!a) return 'none';
  if (a.payoutsEnabled && a.transfersActive) return 'ready';
  return a.detailsSubmitted ? 'stopped' : 'unfinished';
}

export type AffiliatePayoutStatus = 'sending' | 'held' | 'paid';

/** Getting paid: the affiliate's own page and staff's. */
export const AFFILIATE_PAYOUT_WORDS = {
  section: 'Getting paid',
  intro: `Once a month, what’s ready is sent to your bank by Stripe, when it’s at least ${money(AFFILIATE_MIN_PAYOUT_CENTS)}. Less waits for the next month. HandsFreeOS pays Stripe’s fees, so you get all of it.`,
  notOn:
    'Payouts start soon. Set up your bank now, and what you’ve earned is sent once they do. It keeps until then.',
  usOnly: 'For now, payouts go to US bank accounts only.',
  /** The button, by where their bank stands. */
  action: {
    none: 'Set up payouts',
    unfinished: 'Finish with Stripe',
    ready: 'Open your Stripe page',
    stopped: 'Fix it with Stripe',
  } satisfies Record<AffiliateBankState, string>,
  /** The line beside it. */
  bank: {
    none: 'Add your bank on Stripe’s own page. Your bank, tax and identity details go to Stripe, never to us.',
    unfinished:
      'You started setting up payouts with Stripe but didn’t finish. Pick up where you left off.',
    ready: 'Your bank is set up. Your Stripe page shows each payout and lets you change your bank.',
    stopped:
      'Stripe needs something more from you before it can pay you. Open Stripe to see what, and your payouts carry on once it’s done.',
  } satisfies Record<AffiliateBankState, string>,
  checking: 'Checking with Stripe…',
  opening: 'Opening Stripe…',
  back: 'Your bank is set up. Payouts go there from now on.',
  notYet: 'Stripe still needs a few details. Press Finish with Stripe to carry on.',
  payouts: 'Payouts',
  none: 'No payouts yet.',
  status: {
    sending: 'On its way',
    held: 'Waiting on Stripe',
    paid: 'Sent',
  } satisfies Record<AffiliatePayoutStatus, string>,
  sentOn: (date: string) => `Sent ${date}`,
  heldLine:
    'Stripe can’t send it to your bank yet. Open Stripe to see what it needs; it’s sent as soon as it can be.',
  test: 'Test',
} as const;

/** Staff's side, under Admin → Affiliates. */
export const AFFILIATE_PAYOUT_ADMIN_WORDS = {
  switch: 'Pay affiliates',
  on: 'On',
  off: 'Off',
  help: `Once a month, each affiliate owed at least ${money(AFFILIATE_MIN_PAYOUT_CENTS)} is sent what’s ready by Stripe, from HandsFreeOS’s own balance. Leave it off until the terms are read. While it’s off, affiliates can set up their bank and what they’ve earned keeps; nothing is sent.`,
  turnOnTitle: 'Start paying affiliates?',
  turnOnBody: `From the next hour, each affiliate owed at least ${money(AFFILIATE_MIN_PAYOUT_CENTS)} with their bank set up is sent what’s ready, this month and every month after. The money comes from HandsFreeOS’s Stripe balance.`,
  turnOn: 'Start paying',
  turnOffTitle: 'Stop paying affiliates?',
  turnOff: 'Stop paying',
  turnOffBody:
    'Nothing more is sent until you turn it back on. What affiliates are owed keeps, and a payout already on its way still goes.',
  bank: 'Their bank',
  bankState: {
    none: 'Not set up yet',
    unfinished: 'Started with Stripe, not finished',
    ready: 'Set up: Stripe can pay them',
    stopped: 'Stopped: Stripe needs more from them',
  } satisfies Record<AffiliateBankState, string>,
  due: (fields: string) => `Stripe asks for: ${fields}`,
  payouts: 'Their payouts',
  none: 'No payouts yet.',
} as const;
