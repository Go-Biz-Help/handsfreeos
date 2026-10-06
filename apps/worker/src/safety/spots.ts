/**
 * Where a phone was during a check-in is kept 30 days after the check-in ended, then cleared (round seven, Chris
 * 2026-10-05): checked out, answered, or past its planned end for one that never was. Daily, at night, in batches
 * (private.clear_old_safety_spots), like the receipts' clean-up beside it.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { nextReceiptCleanUp } from '../housekeeping/receipts';
import { batchOf } from '../housekeeping/sync-window';

export const SPOT_JOBS = {
  /** Global, daily at night (ensureRecurringJobs). */
  clear: 'safety.clear_spots',
} as const;
export const CLEAR_SPOTS_KEY = 'clear:safety_spots';

const MIN = 60_000;
export const SPOT_BATCH = 5000;
const SPOT_ROUNDS = 40;
const AGAIN_MS = 10 * MIN;

/** With the receipts' clean-up, half an hour before the night's sync-window sweeps. */
export const nextSpotClearing = nextReceiptCleanUp;

/** `safety.clear_spots`: every spot whose check-in ended more than 30 days ago, a batch at a time. */
export const clearOldSpots: JobHandler = async (ctx) => {
  const batch = batchOf(ctx.job.payload, SPOT_BATCH);
  for (let round = 0; round < SPOT_ROUNDS; round++) {
    const [row] = await asWorker(ctx.db, {}, (tx) =>
      rows<{ cleared: number }>(
        tx,
        sql`select private.clear_old_safety_spots(${batch}) as cleared`,
      ),
    );
    if ((row?.cleared ?? 0) < batch) return { rescheduleAt: nextSpotClearing(ctx.now + MIN) };
  }
  return { rescheduleAt: new Date(Date.now() + AGAIN_MS) };
};

export const spotJobs = {
  [SPOT_JOBS.clear]: clearOldSpots,
};
