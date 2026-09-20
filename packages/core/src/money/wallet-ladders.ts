/**
 * The two ladders the usage wallet climbs (M16, step 6), and every number on them.
 *
 * **Escalation** answers Chris's case: a business whose balance keeps running out gets topped up four times in
 * three days and sees four charges on its card. Each top-up inside the window doubles the next, so it is one
 * charge of $100 instead of four of $25 — and the page says so in words, with the one setting that fixes it.
 *
 * **The decline ladder** answers the other half: a card that stops working should be tried again a few times
 * over a few days and then left alone, not hammered every hour until the bank blocks us.
 *
 * All of it is pure, because these are the decisions worth being able to read and test on their own. The worker
 * does the provider calls and the writes; nothing here knows what a database is.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------- escalation ----------

/** How long a run of top-ups counts as one run. Quiet for this long and the ladder is back at the bottom. */
export const ESCALATION_WINDOW_MS = 72 * HOUR_MS;
/**
 * Two top-ups this close together is not a business using its phone, it is one running away — a workflow in a
 * loop, an import gone wrong. It jumps a rung immediately rather than waiting for the window's arithmetic.
 */
export const ESCALATION_RUSH_MS = 6 * HOUR_MS;
/** The top rung. $25 → $50 → $100 → $200 → $400, and no further. */
export const ESCALATION_MAX_STEP = 4;
/**
 * Never more than sixteen times what they chose, whatever the ladder says. Today this is exactly what the top
 * rung already gives (2^4 is 16), so it never binds on its own — it is here so that raising `MAX_STEP` without
 * thinking about the multiple cannot quietly double what a card is charged.
 */
export const ESCALATION_MAX_MULTIPLE = 16;
/** And never more than this, whatever they chose. A runaway must not be able to put thousands on a card. */
export const ESCALATION_HARD_CAP_CENTS = 50_000;
/** Above twice their own amount, somebody is told before the card is charged, not after. */
export const ESCALATION_WARN_MULTIPLE = 2;
/**
 * A business younger than this has no month of spending to measure against, so the "never more than half of
 * what you spent last month" ceiling is not applied to it. Half of nothing is nothing, and a ceiling of nothing
 * would leave a business that signed up this morning unable to put a penny on its balance.
 */
export const NEW_BUSINESS_MS = 30 * DAY_MS;

export interface EscalationState {
  /** Where the ladder was. */
  readonly step: number;
  readonly recharges: number;
  /** When the current run started; null when there is no run. */
  readonly windowStartedAt: number | null;
  readonly lastRechargeAt: number | null;
}

export interface EscalationInput {
  readonly state: EscalationState;
  /** What the business chose one top-up should be. */
  readonly topupCents: number;
  /** What they have spent in the last 30 days. Used for the second ceiling. */
  readonly spent30dCents: number;
  /** When the business opened. Younger than 30 days and the spend ceiling does not apply. */
  readonly workspaceCreatedAt: number;
  readonly now: number;
}

export interface Escalation {
  /** What to charge. */
  readonly amountCents: number;
  /** The rung this amount came from, written on the recharge row so the page can explain it. */
  readonly step: number;
  /** How many top-ups this run has had, counting the one about to happen. */
  readonly recharges: number;
  /** The run this belongs to; a fresh one when the last was long enough ago. */
  readonly windowStartedAt: number;
  /** A ceiling held this back from what the ladder wanted. The page says which. */
  readonly cappedBy: 'multiple' | 'hard' | 'recent_spend' | null;
  /** Somebody is told before this is charged, because it is more than twice what they chose. */
  readonly warnFirst: boolean;
}

/**
 * What the next automatic top-up should be, and which rung it came from.
 *
 * The window is rolling from the **first** top-up of a run, not the last: a business topping up every 20 hours
 * forever should not climb the ladder indefinitely, and 72 quiet hours is what ends a run.
 */
/** Every ceiling that applies to this business today, in the order they are tried. */
function ceilingsFor(
  input: Pick<EscalationInput, 'spent30dCents' | 'workspaceCreatedAt' | 'now'>,
  topup: number,
): { cents: number; by: Escalation['cappedBy'] }[] {
  const ceilings: { cents: number; by: Escalation['cappedBy'] }[] = [
    { cents: topup * ESCALATION_MAX_MULTIPLE, by: 'multiple' },
    { cents: ESCALATION_HARD_CAP_CENTS, by: 'hard' },
  ];
  // A business with a month behind it is never charged more than half of what that month cost. One that opened
  // this week has no month to measure, so this ceiling waits until there is something to measure against.
  if (input.now - input.workspaceCreatedAt >= NEW_BUSINESS_MS)
    ceilings.push({ cents: Math.floor(Math.max(0, input.spent30dCents) / 2), by: 'recent_spend' });
  return ceilings;
}

/**
 * The most one automatic top-up could be for this business today. This is the number the terms call "a cap
 * shown in your account", so it has to be the cap that actually applies — the lowest ceiling in force, never
 * the headline $500 — and it can never read lower than what they chose themselves, because their own amount
 * is always charged in full.
 */
export function escalationCeilingCents(input: {
  readonly topupCents: number;
  readonly spent30dCents: number;
  readonly workspaceCreatedAt: number;
  readonly now: number;
}): number {
  const topup = Math.max(1, Math.round(input.topupCents));
  const lowest = ceilingsFor(input, topup).reduce((a, c) => Math.min(a, c.cents), Infinity);
  return Math.max(topup, lowest);
}

export function nextEscalation(input: EscalationInput): Escalation {
  const { state, now } = input;
  const topup = Math.max(1, Math.round(input.topupCents));
  const runningSince =
    state.windowStartedAt !== null && now - state.windowStartedAt <= ESCALATION_WINDOW_MS
      ? state.windowStartedAt
      : null;

  // A quiet spell ends the run: the next top-up is the business's own amount again.
  if (runningSince === null)
    return {
      amountCents: topup,
      step: 0,
      recharges: 1,
      windowStartedAt: now,
      cappedBy: null,
      warnFirst: false,
    };

  const rushed = state.lastRechargeAt !== null && now - state.lastRechargeAt <= ESCALATION_RUSH_MS;
  // One rung per top-up in the run, and two rungs when they came in a rush.
  const step = Math.min(state.step + (rushed ? 2 : 1), ESCALATION_MAX_STEP);
  const wanted = topup * 2 ** step;

  const ceilings = ceilingsFor(input, topup);

  let amountCents = wanted;
  let cappedBy: Escalation['cappedBy'] = null;
  for (const ceiling of ceilings)
    if (ceiling.cents < amountCents) {
      amountCents = ceiling.cents;
      cappedBy = ceiling.by;
    }
  // A ceiling never takes a top-up below what the business asked for. The ceilings exist to stop *escalation*
  // running away, not to overrule somebody who chose a $1,000 top-up on purpose — and a business held under
  // its own amount is not a runaway being stopped, it is a phone that stops working.
  if (amountCents < topup) {
    amountCents = topup;
    cappedBy = null;
  }

  return {
    amountCents,
    step,
    recharges: state.recharges + 1,
    windowStartedAt: runningSince,
    cappedBy,
    warnFirst: amountCents > topup * ESCALATION_WARN_MULTIPLE,
  };
}

/**
 * What the page says about a raised top-up, in the business's own numbers. The fix is one setting, so it is in
 * the same breath as the problem — a sentence that only explains is a sentence that annoys.
 */
export function escalationWords(input: {
  readonly amountCents: number;
  readonly topupCents: number;
  readonly recharges: number;
  readonly cappedBy: Escalation['cappedBy'];
}): string | null {
  if (input.amountCents <= input.topupCents) return null;
  const money = (c: number) => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`;
  const times = input.recharges === 1 ? 'once' : `${input.recharges} times`;
  const why = `Your top-up is ${money(input.amountCents)} right now because you've topped up ${times} in the last three days.`;
  const fix = `Raising your top-up amount makes this one charge instead of ${input.recharges}.`;
  const held =
    input.cappedBy === 'recent_spend'
      ? ' It is being held down to half of what you spent last month.'
      : input.cappedBy
        ? ' It is at the most we will charge at once.'
        : '';
  return `${why} ${fix}${held}`;
}

// ---------- declines ----------

/**
 * How long after each failure the card is tried again: six hours, a day, three days, and then no more. Three
 * tries over four days is enough for a bank's temporary hold to clear; a fourth is just us being told no again.
 */
export const DECLINE_BACKOFF_MS = [6 * HOUR_MS, DAY_MS, 3 * DAY_MS] as const;

/**
 * Failures with no point in trying again. The card is gone, or it was never right: waiting six hours changes
 * nothing except how long the business spends unable to send a text.
 */
export const TERMINAL_DECLINE_CODES: ReadonlySet<string> = new Set([
  'lost_card',
  'stolen_card',
  'pickup_card',
  'invalid_account',
  'expired_card',
  'incorrect_number',
  'card_not_supported',
  'revocation_of_authorization',
  // Square's spellings of the same answers.
  'CARD_EXPIRED',
  'INVALID_CARD',
  'CARD_DECLINED_VERIFICATION_REQUIRED',
]);

export type DeclineOutcome =
  | { readonly kind: 'retry'; readonly at: number; readonly attempt: number }
  | { readonly kind: 'suspend'; readonly reason: string };

/**
 * What to do about a card that said no. `declinesInRow` is what it was **before** this one, so the first
 * failure arrives as 0 and waits six hours.
 */
export function afterDecline(input: {
  readonly declinesInRow: number;
  readonly failureCode: string | null;
  /** What the provider's own wording said, for the sentence the business reads. */
  readonly failureMessage: string | null;
  readonly now: number;
}): DeclineOutcome {
  const message = input.failureMessage?.trim() || 'That card was declined.';
  if (input.failureCode && TERMINAL_DECLINE_CODES.has(input.failureCode))
    return { kind: 'suspend', reason: message };
  const wait = DECLINE_BACKOFF_MS[input.declinesInRow];
  if (wait === undefined)
    return {
      kind: 'suspend',
      reason: `${message} We tried three times over four days.`,
    };
  return { kind: 'retry', at: input.now + wait, attempt: input.declinesInRow + 1 };
}

// ---------- the floor ----------

/**
 * Whether a balance is low enough to top up. Written as a function rather than a comparison because two places
 * ask it — the event handler and the hourly sweep that catches a lost event — and they must agree.
 */
export const needsTopUp = (input: {
  readonly balanceCents: number;
  readonly floorCents: number;
  readonly autoTopup: boolean;
  readonly hasCard: boolean;
  readonly suspended: boolean;
  readonly pausedUntil: number | null;
  readonly now: number;
}): boolean =>
  input.autoTopup &&
  input.hasCard &&
  !input.suspended &&
  (input.pausedUntil === null || input.pausedUntil <= input.now) &&
  input.balanceCents <= input.floorCents;
