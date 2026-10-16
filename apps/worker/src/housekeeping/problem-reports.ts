/**
 * Problem reports (supabase/migrations/20261027008100_problem_reports.sql): what our own tools saw when something
 * didn't go, read by staff on the desk. Reports older than 30 days go, handled or not. Daily, at night, beside the
 * receipts' clean-up: batches of PROBLEM_REPORT_BATCH (private.delete_old_problem_reports) until one comes back short;
 * a very large backlog carries on a few minutes later.
 */
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { nextReceiptCleanUp } from './receipts';
import { batchOf } from './sync-window';

export const PROBLEM_REPORT_JOBS = {
  /** Global, daily at night (ensureRecurringJobs). */
  cleanUp: 'problem_reports.clean_up',
} as const;
export const PROBLEM_REPORTS_CLEAN_UP_KEY = 'clean-up:problem_reports';

const MIN = 60_000;
// A report may carry a page's outline, up to 200,000 characters: smaller batches than the receipts'.
export const PROBLEM_REPORT_BATCH = 500;
export const PROBLEM_REPORT_ROUNDS = 40;
const AGAIN_MS = 10 * MIN;

/** With the receipts' clean-up: half an hour before the night's sync-window sweeps start. */
export const nextProblemReportCleanUp = (now: number): Date => nextReceiptCleanUp(now);

/** `problem_reports.clean_up`: reports older than 30 days, a batch at a time. */
export const cleanUpProblemReports: JobHandler = async (ctx) => {
  const batch = batchOf(ctx.job.payload, PROBLEM_REPORT_BATCH);
  for (let round = 0; round < PROBLEM_REPORT_ROUNDS; round++) {
    const [row] = await asWorker(ctx.db, {}, (tx) =>
      rows<{ deleted: number }>(
        tx,
        sql`select private.delete_old_problem_reports(${batch}) as deleted`,
      ),
    );
    if ((row?.deleted ?? 0) < batch)
      return { rescheduleAt: nextProblemReportCleanUp(ctx.now + MIN) };
  }
  return { rescheduleAt: new Date(Date.now() + AGAIN_MS) };
};

export const problemReportJobs = {
  [PROBLEM_REPORT_JOBS.cleanUp]: cleanUpProblemReports,
};
