/**
 * Ranking (blueprint §38): score = 100 × log10(10 + V) × U × P × C, with V in dollars.
 * - V: the item's value (a lead's own value, or the typical job value as an estimate).
 * - U: urgency, worked out when the list is read so waiting time is always current. From 1 (a hot lead from 2),
 *   growing with the time since the wait began, capped at 3; an appointment's grows from 1 to 3 over the two days
 *   before it starts.
 * - P and C: the detection's probability and confidence.
 * A $40,000 lead showing buying intent outranks a $50 reminder however late the reminder is.
 */
import type { AttentionKind } from './kinds';
import type { ReasonCode } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const URGENCY_CAP = 3;

export type UrgencyRule =
  /** From `start`, plus one for each `stepMs` since the wait began (`since`, else `dueAt`). */
  | { readonly grows: 'since'; readonly start: number; readonly stepMs: number }
  /** From 1, `windowMs` before `dueAt`, to the cap at `dueAt`. */
  | { readonly grows: 'until_due'; readonly windowMs: number };

export const URGENCY_RULES: Readonly<Record<AttentionKind, UrgencyRule>> = {
  // Hot means act now: it starts at 2 and is at the cap once it has waited 10 minutes.
  hot_lead: { grows: 'since', start: 2, stepMs: 10 * MIN },
  unanswered_lead: { grows: 'since', start: 1, stepMs: 30 * MIN },
  stale_opportunity: { grows: 'since', start: 1, stepMs: 30 * DAY },
  missing_next_action: { grows: 'since', start: 1, stepMs: 5 * DAY },
  unconfirmed_appointment: { grows: 'until_due', windowMs: 48 * HOUR },
  ai_approval: { grows: 'since', start: 1, stepMs: 2 * HOUR },
  customer_waiting: { grows: 'since', start: 1, stepMs: 30 * MIN },
  overdue_task: { grows: 'since', start: 1, stepMs: 3 * DAY },
  // A quote goes cold: from the day it was sent, at the cap after ten days of silence.
  estimate_waiting: { grows: 'since', start: 1, stepMs: 5 * DAY },
  // Money owed climbs slowly — its size does the talking — and is at the cap three weeks past the due day.
  invoice_overdue: { grows: 'since', start: 1, stepMs: 10 * DAY },
  // A low balance is a warning, not an emergency: it climbs slowly and there is still money.
  wallet_low: { grows: 'since', start: 1, stepMs: 2 * DAY },
  // These two start at the cap. The business cannot send a text; there is no "getting worse" about it.
  wallet_empty: { grows: 'since', start: URGENCY_CAP, stepMs: DAY },
  wallet_card_declined: { grows: 'since', start: URGENCY_CAP, stepMs: DAY },
  // A thank-you is best the same day: it climbs through the day after.
  job_not_thanked: { grows: 'since', start: 1, stepMs: DAY },
  // Somebody new who needs the business cools off in days, not weeks.
  referral_mentioned: { grows: 'since', start: 1.5, stepMs: 2 * DAY },
  // Overdue already, and two texts went: steady, not urgent.
  maintenance_due: { grows: 'since', start: 1, stepMs: 5 * DAY },
  // Housekeeping: a deal on the wrong stage skews the board, not a customer.
  pipeline_mismatch: { grows: 'since', start: 1, stepMs: 7 * DAY },
  // A price with no answer goes cold in days.
  quiet_after_price: { grows: 'since', start: 1, stepMs: 3 * DAY },
  // A job nobody marked holds up its invoice and its thank-you: it climbs by the day.
  job_unconfirmed: { grows: 'since', start: 1, stepMs: DAY },
  job_never_completed: { grows: 'since', start: 1.5, stepMs: 3 * DAY },
  // Someone has to know where to go before they set off.
  job_no_address: { grows: 'until_due', windowMs: 48 * HOUR },
};

/**
 * Chips that take the edge off an item's urgency, and by how much. A hot lead the AI teammate or a workflow has
 * already answered ("auto-replied") still needs a person, at half the urgency.
 */
export const URGENCY_DAMPERS: Readonly<Partial<Record<ReasonCode, number>>> = {
  auto_replied: 0.5,
};

/** What scoring reads from an item (a detection, or a stored row). */
export interface Scorable {
  readonly kind: AttentionKind;
  /** Cents. */
  readonly value: number;
  readonly probability: number;
  readonly confidence: number;
  readonly since: string | null;
  readonly dueAt: string | null;
  readonly urgentFrom: string | null;
  /** Its reason chips, for the dampers; none means none apply. */
  readonly reasons?: readonly { readonly code: string }[];
}

const damping = (reasons: Scorable['reasons']): number =>
  (reasons ?? []).reduce((f, r) => f * (URGENCY_DAMPERS[r.code as ReasonCode] ?? 1), 1);

const msOf = (now: Date | number) => (typeof now === 'number' ? now : now.getTime());
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const parse = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** U: from 1 to 3, less any dampers on its chips (an auto-replied hot lead's is halved). */
export function urgencyOf(
  item: Pick<Scorable, 'kind' | 'since' | 'dueAt' | 'reasons'>,
  now: Date | number,
): number {
  return rawUrgency(item, now) * damping(item.reasons);
}

function rawUrgency(item: Pick<Scorable, 'kind' | 'since' | 'dueAt'>, now: Date | number): number {
  const rule = URGENCY_RULES[item.kind];
  const at = msOf(now);
  if (rule.grows === 'until_due') {
    const due = parse(item.dueAt);
    if (due === null) return 1;
    return 1 + (URGENCY_CAP - 1) * clamp(1 - (due - at) / rule.windowMs, 0, 1);
  }
  const from = parse(item.since) ?? parse(item.dueAt);
  if (from === null) return rule.start;
  return Math.min(URGENCY_CAP, rule.start + Math.max(0, at - from) / rule.stepMs);
}

/** 100 × log10(10 + V) × U × P × C. */
export function scoreOf(item: Scorable, now: Date | number): number {
  const dollars = Math.max(0, item.value) / 100;
  return (
    100 *
    Math.log10(10 + dollars) *
    urgencyOf(item, now) *
    clamp(item.probability, 0, 1) *
    clamp(item.confidence, 0, 1)
  );
}

/** Past its urgent moment: the Urgent section and the urgent email. */
export function isUrgent(item: Pick<Scorable, 'urgentFrom'>, now: Date | number): boolean {
  const from = parse(item.urgentFrom);
  return from !== null && msOf(now) >= from;
}

const compare = (a: number | string, b: number | string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The list's order, the same on Home, in the morning email and for the Assistant: urgent items first, then by
 * score; ties by the earlier deadline, then by id (or fingerprint) so the order never flickers.
 */
export function rankItems<
  T extends Scorable & { readonly id?: string; readonly fingerprint?: string },
>(items: readonly T[], now: Date | number): T[] {
  return items
    .map((item) => ({
      item,
      urgent: isUrgent(item, now),
      score: scoreOf(item, now),
      due: parse(item.dueAt) ?? Number.POSITIVE_INFINITY,
      key: item.id ?? item.fingerprint ?? '',
    }))
    .sort(
      (a, b) =>
        Number(b.urgent) - Number(a.urgent) ||
        b.score - a.score ||
        compare(a.due, b.due) ||
        compare(a.key, b.key),
    )
    .map((r) => r.item);
}

export interface AffectedItem {
  readonly value: number;
  readonly valueIsEstimate: boolean;
  readonly moneyKey: string | null;
  /**
   * The lead the item belongs to, when it has one. An overdue invoice for a job already counted is that job's
   * money seen again, not more of it: both count under the lead, and the larger figure stands. An invoice with
   * no lead (the work came in some other way) counts on its own.
   */
  readonly leadId?: string | null;
}

/**
 * "$X affected", in cents: money owed, each job counted once (its largest figure), estimates left out until
 * someone accepts one and it becomes an invoice.
 */
export function affectedCents(items: readonly AffectedItem[]): number {
  const byKey = new Map<string, number>();
  for (const i of items) {
    const key = i.leadId ? `lead:${i.leadId}` : i.moneyKey;
    if (i.valueIsEstimate || !key || i.value <= 0) continue;
    byKey.set(key, Math.max(byKey.get(key) ?? 0, i.value));
  }
  let total = 0;
  for (const v of byKey.values()) total += v;
  return total;
}
