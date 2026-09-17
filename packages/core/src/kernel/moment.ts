/**
 * When a change was made (M10). A change from the phone carries the moment the person made it, already on the server's
 * clock and never later than now (`RequestMeta.occurredAt`); everything else (the web, the worker) is made now.
 *
 * What the person did is stamped with that moment: its timeline entries, a lead's stage entry, a tick, an archive, a
 * close, a snooze or a dismissal, a tag, a file added, cash taken, a decision. What only happens once the change
 * arrives keeps now: a text or email going out and its delivery, a provider's payment, a call, a snooze's end (the
 * person chose it), and bookkeeping such as `created_at` and a receipt's `received_at`.
 */
import { sql, type Tx } from '@hfos/db/client';
import type { RequestMeta } from './types';

/** When the change was made: the phone's corrected moment, or now. */
export const changeMoment = (meta: RequestMeta): Date => meta.occurredAt ?? new Date();

/**
 * Hands the change's moment to the database for the rest of the transaction, so the times it stamps itself (a lead's
 * stage entry, an attention item's snooze, a staff confirmation: private.change_moment, 0062) agree with the command's
 * own. Only a change with a moment of its own sets it; the database uses now otherwise.
 */
export async function shareChangeMoment(tx: Tx, meta: RequestMeta): Promise<void> {
  if (!meta.occurredAt) return;
  await tx.execute(
    sql`select set_config('app.occurred_at', ${meta.occurredAt.toISOString()}, true)`,
  );
}
