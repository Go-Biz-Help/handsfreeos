/**
 * What a detector says about one subject, and the chips that explain an item's rank. Browser-safe.
 *
 * A detection maps onto `app.attention_items`: value → value_cents, since → since_at, urgentFrom → urgent_from,
 * dueAt → due_at, assignee → assignee_user_id, reasons → reasons. Times are ISO strings.
 */
import type { AttentionKind } from './kinds';

export const REASON_CODES = [
  'value',
  'waiting',
  'not_contacted',
  'auto_replied',
  'ready_to_book',
  'qualified',
  'repeat_customer',
  'came_in_today',
  'handed_off',
  'last_contact',
  'no_contact',
  'follow_up_overdue',
  'no_next_action',
  'next_action',
  'starts_in',
  'asked_to_confirm',
  'draft',
  'approval',
  'expires_in',
  'overdue',
  'stage',
  'not_a_fit',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** One reason chip: "$18,500", "waiting 11 min", "qualified", "Last contact 9 days ago", "ready to book". */
export interface AttentionChip {
  readonly code: ReasonCode;
  /** The words as of detection. A chip with `since` or `until` ticks: `chipText` gives its words at any moment. */
  readonly label: string;
  /** Counts up from this instant: "waiting 11 min", "Last contact 9 days ago", "2 days overdue". */
  readonly since?: string;
  /** Counts down to this instant: "starts in 5 h", "expires in 40 min". */
  readonly until?: string;
}

/** What one detector found about one subject. */
export interface Detection {
  /** A digest of the facts behind it: a dismissed or snoozed item comes back only when it changes. */
  readonly fingerprint: string;
  /** When the wait behind it began; urgency grows from here, worked out when the list is read. */
  readonly since: string | null;
  /** When it counts as urgent (the Urgent section and the urgent email); null when it never does. */
  readonly urgentFrom: string | null;
  /** Its deadline: when a reply was due, a follow-up's time, a task's due time, an appointment's start. */
  readonly dueAt: string | null;
  /** V, in cents: the lead's value, or the business's typical job value (an estimate). */
  readonly value: number;
  readonly valueIsEstimate: boolean;
  /** Counts one lead's value once in "$ affected", however many items share it; null for an estimate. */
  readonly moneyKey: string | null;
  /** P, 0 to 1. */
  readonly probability: number;
  /** C, 0 to 1: how sure the rule is. */
  readonly confidence: number;
  /** The chips that explain it, most telling first. */
  readonly reasons: readonly AttentionChip[];
  /** Whose it is: the lead's, conversation's or task's owner, or the item's own. */
  readonly assignee: string | null;
  /** When to look again while it holds (it turns urgent, an appointment starts, an approval expires). */
  readonly recheckAt: string | null;
}

/** A detection with the subject it's about: what folding and the loaders work with. */
export interface AttentionCandidate {
  readonly kind: AttentionKind;
  readonly subjectId: string;
  readonly leadId: string | null;
  readonly personId: string | null;
  readonly detection: Detection;
}
