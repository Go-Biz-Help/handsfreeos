/**
 * What a detector says about one subject, and the chips that explain an item's rank. Browser-safe.
 *
 * A detection maps onto `app.attention_items`: value → value_cents, since → since_at, urgentFrom → urgent_from,
 * dueAt → due_at, assignee → assignee_user_id, reasons → reasons. Times are ISO strings.
 */
import type { AttentionKind } from './kinds';

export const REASON_CODES = [
  'value',
  /** Money this item is about: "$1,240 owed" on an invoice, "$8,400 quoted" on an estimate. */
  'amount',
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
  /** Sent, and the customer hasn't opened it yet: it may never have arrived. */
  'not_viewed',
  'stage',
  'not_a_fit',
  /** A job marked done, counting up: "job done 3 h ago". */
  'job_done',
  /** Who a referral is and what they need: "neighbour · AC looked at". */
  'referral',
  /** A regular service that's due and not booked: "AC tune-up due Oct 5". */
  'maintenance',
  /** A price the customer heard and hasn't answered: "$450 by text". */
  'price',
  /** A visit whose time has passed with nobody saying how it went: "AC tune-up · Tue 2:00 PM". */
  'job_passed',
  /** A visit at the customer's place with nowhere to go. */
  'no_address',
  /** A regular who hasn't been back: "Usually every 3 months · 7 months since". */
  'quiet',
  /** What someone on the team said they'd do: "You said: send the quote · Tue". */
  'promise',
  /** Last week's money in against the usual week: "$6,200 last week · usually $9,000 (−31%)". */
  'revenue',
  /** A channel's usual pace: "Texts usually every 2 h". */
  'quiet_channel',
  /** Nothing for a while, counting up: "nothing for 1 day" (a quiet channel, a silent connection). */
  'silent',
  /** What broke on a connection: "Sign-in expired", "Access removed". */
  'broken',
  /** The AI's work nobody looked at: "14 drafts · none reviewed in 7 days". */
  'unreviewed',
  /** What the AI was corrected on, as one line of guidance. */
  'corrected',
  /** Where what the AI knows says otherwise: "Hours says “Open 7 days a week”". */
  'knows_otherwise',
  /** What changed on the website: "3 pages changed · 4 updates". */
  'site_changed',
  /** A question customers keep asking: "“Do you work Sundays?” · asked 4 times". */
  'asked',
  /** An offer about to end: "Fall tune-up $89 · ends Oct 31". */
  'offer_ends',
  /** How serious an add-on says its alert is: "Critical", "At risk". */
  'severity',
  /** An add-on's deadline still ahead, counting down: "due in 2 days". */
  'due_in',
  /** An add-on's alert that asks someone to say they've seen it. */
  'needs_ack',
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
