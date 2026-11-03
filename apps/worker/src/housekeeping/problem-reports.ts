/**
 * Problem reports (supabase/migrations/20261027008100_problem_reports.sql): what our own tools saw when something
 * didn't go, read by staff on the desk. Reports older than 30 days go, handled or not. Daily, at night, beside the
 * receipts' clean-up: batches of PROBLEM_REPORT_BATCH (private.delete_old_problem_reports) until one comes back short;
 * a very large backlog carries on a few minutes later. The AI helper's learned ways that haven't worked in 90 days go
 * first, in one batch (20261027021600, private.delete_stale_learned_ways): there are only ever a few.
 *
 * Every hour, reports clear themselves (20261027023100): they move to Handled with why. A limit once it's over
 * (private.clear_problem_reports), a problem that hasn't happened again for PROBLEM_QUIET_DAYS (the same), and every
 * report of a problem core's PROBLEM_FIXES says was fixed, from before its fix (private.clear_fixed_problem_reports).
 */
import { PROBLEM_FIXES, PROBLEM_QUIET_DAYS, problemFixReady } from '@hfos/core';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobHandler } from '../jobs';
import { nextReceiptCleanUp } from './receipts';
import { batchOf } from './sync-window';

export const PROBLEM_REPORT_JOBS = {
  /** Global, daily at night (ensureRecurringJobs). */
  cleanUp: 'problem_reports.clean_up',
  /** Global, every hour (ensureRecurringJobs). */
  clear: 'problem_reports.clear',
} as const;
export const PROBLEM_REPORTS_CLEAN_UP_KEY = 'clean-up:problem_reports';
export const PROBLEM_REPORTS_CLEAR_KEY = 'clear:problem_reports';

const MIN = 60_000;
// A report may carry a page's outline, up to 200,000 characters: smaller batches than the receipts'.
export const PROBLEM_REPORT_BATCH = 500;
export const PROBLEM_REPORT_ROUNDS = 40;
/** Learned ways a night: more than ever pile up. */
export const LEARNED_WAY_BATCH = 1000;
const AGAIN_MS = 10 * MIN;

/** With the receipts' clean-up: half an hour before the night's sync-window sweeps start. */
export const nextProblemReportCleanUp = (now: number): Date => nextReceiptCleanUp(now);

/** `problem_reports.clean_up`: reports older than 30 days, a batch at a time. */
export const cleanUpProblemReports: JobHandler = async (ctx) => {
  const batch = batchOf(ctx.job.payload, PROBLEM_REPORT_BATCH);
  await asWorker(ctx.db, {}, (tx) =>
    rows(tx, sql`select private.delete_stale_learned_ways(${LEARNED_WAY_BATCH}) as deleted`),
  );
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

/** Reports cleared a go, of each kind; a bigger pile carries on a minute later. */
export const PROBLEM_CLEAR_BATCH = 2000;
const HOUR = 60 * MIN;

/** Every hour, a few minutes past, so a limit that ended at midnight clears soon after. */
export const nextProblemReportClearing = (now: number): Date =>
  new Date(Math.floor(now / HOUR) * HOUR + HOUR + 7 * MIN);

/** `problem_reports.clear`: limits that are over, problems gone quiet, and problems fixed, to Handled. */
export const clearProblemReports: JobHandler = async (ctx) => {
  const batch = batchOf(ctx.job.payload, PROBLEM_CLEAR_BATCH);
  const [cleared] = await asWorker(ctx.db, {}, (tx) =>
    rows<{ limit_over: number; quiet: number }>(
      tx,
      sql`select * from private.clear_problem_reports(${PROBLEM_QUIET_DAYS}, ${batch})`,
    ),
  );
  let more = (cleared?.limit_over ?? 0) >= batch || (cleared?.quiet ?? 0) >= batch;
  for (const fix of PROBLEM_FIXES) {
    if (!problemFixReady(fix)) continue;
    const [row] = await asWorker(ctx.db, {}, (tx) =>
      rows<{ cleared: number }>(
        tx,
        sql`select private.clear_fixed_problem_reports(${fix.source ?? 'extension'}, ${fix.area}, ${fix.job},
          ${fix.note ?? null}::text, ${fix.fixedIn ?? null}::text, ${fix.before ?? null}::timestamptz,
          ${batch}) as cleared`,
      ),
    );
    if ((row?.cleared ?? 0) >= batch) more = true;
  }
  return { rescheduleAt: more ? new Date(ctx.now + MIN) : nextProblemReportClearing(ctx.now) };
};

export const problemReportJobs = {
  [PROBLEM_REPORT_JOBS.cleanUp]: cleanUpProblemReports,
  [PROBLEM_REPORT_JOBS.clear]: clearProblemReports,
};
