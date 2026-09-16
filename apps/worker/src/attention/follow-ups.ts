/**
 * Step 6's seam: what happens after the list changed. settle() calls afterSettle at the end of every reconcile the
 * worker runs (after an event, at a recheck, when a snooze runs out, in the hourly sweep, and through the test
 * route), inside the same transaction, after the attention_item.* events are recorded and while reconcile's
 * per-business lock is still held. It should only schedule work (jobs with fixed dedupe keys), never send.
 *
 * What the outcome offers (settle.ts):
 * - `becameUrgent`: open items that turned urgent now, once per fingerprint, with the first-sweep guard already
 *   applied (old clocks never appear here; they get alert_fingerprint = fingerprint instead). The urgent email's
 *   trigger: schedule `attention.urgent_alert` per item.
 * - `autoCandidates`: items that opened, came back with new facts, or woke from a snooze, whose kind may run on its
 *   own (autoActionOf: a confirmation request, or a nudge for a stale lead or an overdue follow-up). The automatic
 *   handling's trigger: check the switches (planAutoAction doesn't) and schedule `attention.auto_handle`.
 * - `transitions`: everything else. A resolved item's scheduled automatic action is already marked skipped
 *   ('resolved') by reconcile.
 * - `now`, `scope` and `cause` (to chain what it records).
 * The hourly sweep's outcome also covers items that were already open: an automatic kind whose switch was turned on
 * later has no transition, so step 6 finds those itself (open, auto_state null) when it runs for a sweep.
 */
import type { Tx } from '@hfos/db/client';
import type { SettleOutcome } from './settle';

export function afterSettle(_tx: Tx, _outcome: SettleOutcome): Promise<void> {
  // Step 6 (automatic handling and urgent alerts) plugs in here.
  return Promise.resolve();
}
