/**
 * Step 6's seam: what happens after the list changed. settle() calls afterSettle at the end of every reconcile the
 * worker runs (after an event, at a recheck, when a snooze runs out, in the hourly sweep, and through the test
 * route), inside the same transaction, after the attention_item.* events are recorded and while reconcile's
 * per-business lock is still held. It only schedules work (jobs with fixed dedupe keys); it never sends.
 *
 * - **Urgent alerts** (alerts.ts): one `attention.urgent_alert` per item that turned urgent, once per fingerprint.
 *   Old clocks never reach here (settle.ts's first-sweep guard marks them as already alerted).
 * - **Automatic handling** (auto.ts): items that opened, came back with new facts or woke from a snooze, whose
 *   kind may run on its own and whose switch is on, are recorded as scheduled and queued for the end of their
 *   cancel window. A sweep also picks up items whose switch was turned on after they opened.
 */
import type { Tx } from '@hfos/db/client';
import { planUrgentAlerts } from './alerts';
import { planAutoActions } from './auto';
import type { SettleOutcome } from './settle';

export async function afterSettle(tx: Tx, outcome: SettleOutcome): Promise<void> {
  await planUrgentAlerts(tx, outcome);
  await planAutoActions(tx, outcome);
}
