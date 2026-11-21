/**
 * Billing for a founding plan (20261027023600, the owner's call of 2026-11-08): when a declined payment is tried
 * again, and when the failed-payment page shows, can be skipped, and can't. Browser-safe: the web, the phone and the
 * worker all decide with these.
 *
 * - **Retries:** once a day, at a random time in that day, for `PLAN_RETRY_DAYS` days. Day 1 is the 24 hours that
 *   start a day after the payment failed (or after more time ran out). Each try goes through the default card and
 *   then each backup.
 * - **The page:** shown to everyone in the business from the next screen they open after a payment fails. It can be
 *   skipped for `PAY_SKIP_HOURS` at a time, until `PAY_LOCK_HOURS` after the failure; then it can't be skipped. More
 *   time granted by staff takes it away until that day.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How many days a declined payment is tried again on its own, once a day. */
export const PLAN_RETRY_DAYS = 14;
/** How long one press of Skip for now lasts. */
export const PAY_SKIP_HOURS = 24;
/** After this long, the failed-payment page can't be skipped. */
export const PAY_LOCK_HOURS = 72;
/** The furthest day a business may ask for more time until. */
export const MORE_TIME_MAX_DAYS = 30;
/**
 * How many days before a free trial ends its business is told (20261027027000, the owner's pick): an email from the
 * worker, and a note at the top of the web app for whoever manages money.
 */
export const TRIAL_ENDING_DAYS = 3;

/**
 * When the next automatic retry is, after `retriesMade` of them since `from`: a random moment in day
 * `retriesMade + 1`, or null once the last day's has been made. `random` is 0 to 1 (Math.random in the worker).
 */
export function nextPlanRetryAt(from: Date, retriesMade: number, random: number): Date | null {
  const day = retriesMade + 1;
  if (day > PLAN_RETRY_DAYS) return null;
  const r = Math.min(Math.max(random, 0), 0.999);
  return new Date(from.getTime() + day * DAY_MS + Math.floor(r * DAY_MS));
}

/** What `billing.status` says about money owed, as the page needs it. */
export interface PlanOwedFacts {
  /** When the payment first failed. */
  readonly failedAt: string;
  /** Staff gave the business until then to pay. */
  readonly moreTimeUntil: string | null;
}

export interface PaymentBlock {
  /** Put the failed-payment page in front of the CRM. */
  readonly show: boolean;
  /** Skip for now is offered. */
  readonly canSkip: boolean;
  /** When skipping stops being offered. */
  readonly lockedAt: string;
}

/**
 * Whether the failed-payment page shows now. `skippedUntil` is when this person's last Skip for now runs out (kept on
 * their device), or null.
 */
export function paymentBlockOf(
  owed: PlanOwedFacts | null,
  now: Date,
  skippedUntil: string | null,
): PaymentBlock | null {
  if (!owed) return null;
  if (owed.moreTimeUntil && new Date(owed.moreTimeUntil).getTime() > now.getTime()) return null;
  const lockedAt = new Date(new Date(owed.failedAt).getTime() + PAY_LOCK_HOURS * HOUR_MS);
  const canSkip = now.getTime() < lockedAt.getTime();
  const skipped = canSkip && !!skippedUntil && new Date(skippedUntil).getTime() > now.getTime();
  return { show: !skipped, canSkip, lockedAt: lockedAt.toISOString() };
}

/** When a Skip for now pressed at `now` runs out: a day later, or when skipping stops, whichever is first. */
export function paymentSkipUntil(owed: PlanOwedFacts, now: Date): string {
  const lockedAt = new Date(owed.failedAt).getTime() + PAY_LOCK_HOURS * HOUR_MS;
  return new Date(Math.min(now.getTime() + PAY_SKIP_HOURS * HOUR_MS, lockedAt)).toISOString();
}

/** The days a business may pick to pay by when it asks for more time: tomorrow to `MORE_TIME_MAX_DAYS` out (UTC). */
export function moreTimeBounds(now: Date): { earliest: string; latest: string } {
  const day = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
      .toISOString()
      .slice(0, 10);
  return { earliest: day(1), latest: day(MORE_TIME_MAX_DAYS) };
}
