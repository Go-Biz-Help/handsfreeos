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
}

const msOf = (now: Date | number) => (typeof now === 'number' ? now : now.getTime());
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const parse = (iso: string | null) => (iso ? Date.parse(iso) : null);

/** U, from 1 to 3. */
export function urgencyOf(
  item: Pick<Scorable, 'kind' | 'since' | 'dueAt'>,
  now: Date | number,
): number {
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
}

/** "$X affected", in cents: each money key once (its largest value), estimates left out. */
export function affectedCents(items: readonly AffectedItem[]): number {
  const byKey = new Map<string, number>();
  for (const i of items) {
    if (i.valueIsEstimate || !i.moneyKey || i.value <= 0) continue;
    byKey.set(i.moneyKey, Math.max(byKey.get(i.moneyKey) ?? 0, i.value));
  }
  let total = 0;
  for (const v of byKey.values()) total += v;
  return total;
}
