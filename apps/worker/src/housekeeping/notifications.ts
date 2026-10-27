/**
 * Notifications under the bell (supabase/migrations/20261027012600_notifications_under_the_bell.sql): every push a
 * person's phones were handed, kept for them. Those older than 30 days go, and so do the support desk's of anyone who
 * no longer answers support. Daily, at night, beside the receipts' clean-up: batches of NOTIFICATION_BATCH
 * (private.delete_old_notifications) until one comes back short; a very large backlog carries on a few minutes later.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { nextReceiptCleanUp } from './receipts';
import { batchOf } from './sync-window';

export const NOTIFICATION_JOBS = {
  /** Global, daily at night (ensureRecurringJobs). */
  cleanUp: 'notifications.clean_up',
} as const;
export const NOTIFICATIONS_CLEAN_UP_KEY = 'clean-up:notifications';

const MIN = 60_000;
export const NOTIFICATION_BATCH = 5000;
export const NOTIFICATION_ROUNDS = 40;
const AGAIN_MS = 10 * MIN;

/** With the receipts' clean-up: half an hour before the night's sync-window sweeps start. */
export const nextNotificationCleanUp = (now: number): Date => nextReceiptCleanUp(now);

/** `notifications.clean_up`: notifications older than 30 days, a batch at a time. */
export const cleanUpNotifications: JobHandler = async (ctx) => {
  const batch = batchOf(ctx.job.payload, NOTIFICATION_BATCH);
  for (let round = 0; round < NOTIFICATION_ROUNDS; round++) {
    const [row] = await asWorker(ctx.db, {}, (tx) =>
      rows<{ deleted: number }>(
        tx,
        sql`select private.delete_old_notifications(${batch}) as deleted`,
      ),
    );
    if ((row?.deleted ?? 0) < batch)
      return { rescheduleAt: nextNotificationCleanUp(ctx.now + MIN) };
  }
  return { rescheduleAt: new Date(Date.now() + AGAIN_MS) };
};

export const notificationJobs = {
  [NOTIFICATION_JOBS.cleanUp]: cleanUpNotifications,
};
