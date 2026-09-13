import { eq } from 'drizzle-orm';
import { asWorker, rows, sql, type SystemScope } from '@hfos/db/client';
import { scheduledJobs } from '@hfos/db/schema';
import { backoffMs, errorMessage, MAX_ATTEMPTS } from './outbox';
import type { WorkerServices } from './services';

export type JobRow = typeof scheduledJobs.$inferSelect;

export interface JobContext extends WorkerServices {
  readonly job: JobRow;
  readonly scope: SystemScope;
  readonly attempt: number;
  /** The moment the job runs as of: now, except when the test route runs a job as of when it was due. */
  readonly now: number;
}

/** A job either finishes or asks to run again later (a reminder that is not due yet, a registration still in review). */
export type JobResult = void | { readonly rescheduleAt: Date };
export type JobHandler = (ctx: JobContext) => Promise<JobResult>;
export type JobMap = Readonly<Record<string, JobHandler>>;

export interface JobDeps extends WorkerServices {
  readonly jobs: JobMap;
  readonly workerId: string;
  readonly batchSize: number;
  /** Only claim rows this worker id already reserved (tests and the seed, which share a database with other pollers). */
  readonly reservedOnly?: boolean;
  /** The moment each job runs as of (the test route and tests; default: now). */
  readonly clock?: (job: JobRow) => number;
}

export interface JobStats {
  claimed: number;
  done: number;
  rescheduled: number;
  retried: number;
  failed: number;
}

/**
 * The queue seam: delayed and periodic work lives in app.scheduled_jobs and is claimed like the outbox.
 * pgmq (or another queue) can replace the storage later behind the same two functions.
 */
export async function processJobs(deps: JobDeps): Promise<JobStats> {
  const stats: JobStats = { claimed: 0, done: 0, rescheduled: 0, retried: 0, failed: 0 };
  const claimed = await asWorker(deps.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`with claimed as (update app.scheduled_jobs j set locked_at = now(), locked_by = ${deps.workerId}
          where j.id in (
            select id from app.scheduled_jobs
            where status = 'pending' and run_at <= now()
              and (locked_at is null or locked_at < now() - interval '5 minutes' or locked_by = ${deps.workerId})
              ${deps.reservedOnly ? sql`and locked_by = ${deps.workerId}` : sql``}
            order by run_at
            limit ${deps.batchSize}
            for update skip locked)
          returning j.id, j.run_at)
          select id from claimed order by run_at, id`,
    ),
  );
  stats.claimed = claimed.length;
  for (const { id } of claimed) {
    const [job] = await asWorker(deps.db, {}, (tx) =>
      tx.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)),
    );
    if (!job) continue;
    const handler = deps.jobs[job.kind];
    const finish = (set: Partial<typeof scheduledJobs.$inferInsert>) =>
      asWorker(deps.db, {}, (tx) =>
        tx
          .update(scheduledJobs)
          .set({ ...set, lockedAt: null, lockedBy: null })
          .where(eq(scheduledJobs.id, id)),
      );
    if (!handler) {
      await finish({
        status: 'failed',
        lastError: `no handler for ${job.kind}`,
        finishedAt: new Date(),
      });
      stats.failed++;
      continue;
    }
    try {
      const result = await handler({
        ...deps,
        job,
        scope: { workspaceId: job.workspaceId, organizationId: job.organizationId },
        attempt: job.attempts + 1,
        now: deps.clock ? deps.clock(job) : Date.now(),
        log: deps.log.child({ jobId: id, kind: job.kind }),
      });
      if (result?.rescheduleAt) {
        await finish({ runAt: result.rescheduleAt, lastError: null });
        stats.rescheduled++;
      } else {
        await finish({ status: 'done', finishedAt: new Date(), lastError: null });
        stats.done++;
      }
    } catch (e) {
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const message = errorMessage(e);
      deps.log.warn({ jobId: id, kind: job.kind, attempts, failed, err: message }, 'job failed');
      await finish({
        status: failed ? 'failed' : 'pending',
        attempts,
        runAt: new Date(Date.now() + backoffMs(attempts)),
        lastError: message.slice(0, 2000),
        ...(failed ? { finishedAt: new Date() } : {}),
      });
      if (failed) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
