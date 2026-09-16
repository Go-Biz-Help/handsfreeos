/**
 * Command receipts (M10): every command from the phone leaves one, so a repeat gets the first answer back. A phone
 * that hasn't synced for 30 days locks its copy, so nothing that old is ever sent again, and receipts older than 90
 * days go. Daily, at night: batches of RECEIPT_BATCH (private.delete_expired_command_receipts) with a pause between,
 * until a batch comes back short; a very large backlog carries on a few minutes later.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { batchOf, SWEEP_UTC_HOUR } from './sync-window';

export const RECEIPT_JOBS = {
  /** Global, daily at night (ensureRecurringJobs). */
  cleanUp: 'command_receipts.clean_up',
} as const;
export const RECEIPTS_CLEAN_UP_KEY = 'clean-up:command_receipts';

const MIN = 60_000;
export const RECEIPT_BATCH = 5000;
export const RECEIPT_ROUNDS = 40;
const PAUSE_MS = 200;
const AGAIN_MS = 10 * MIN;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Half an hour before the night's sync-window sweeps start. */
export function nextReceiptCleanUp(now: number): Date {
  const at = new Date(now);
  at.setUTCHours(SWEEP_UTC_HOUR - 1, 30, 0, 0);
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/** `command_receipts.clean_up`: receipts older than 90 days, a batch at a time. */
export const cleanUpReceipts: JobHandler = async (ctx) => {
  const batch = batchOf(ctx.job.payload, RECEIPT_BATCH);
  for (let round = 0; round < RECEIPT_ROUNDS; round++) {
    if (round > 0) await pause(PAUSE_MS);
    const [row] = await asWorker(ctx.db, {}, (tx) =>
      rows<{ deleted: number }>(
        tx,
        sql`select private.delete_expired_command_receipts(${batch}) as deleted`,
      ),
    );
    if ((row?.deleted ?? 0) < batch) return { rescheduleAt: nextReceiptCleanUp(ctx.now + MIN) };
  }
  return { rescheduleAt: new Date(Date.now() + AGAIN_MS) };
};

export const receiptJobs = {
  [RECEIPT_JOBS.cleanUp]: cleanUpReceipts,
};
