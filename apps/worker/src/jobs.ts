import { eq } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { asWorker, rows, sql, type SystemScope, type Tx } from '@hfos/db/client';
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
 * A wake asked for while the job ran: scheduleJob with pullEarlier can't move a running job (its run_at is
 * already past), so it leaves `_wakeAt` in the payload instead (see scheduleJob in core). Finishing never
 * leaves the job later than that wake, and a job that would be done runs again at it.
 */
const wakeAt = sql`(${scheduledJobs.payload} ->> '_wakeAt')::timestamptz`;
const withoutWake = sql`${scheduledJobs.payload} - '_wakeAt'`;
const notLaterThanWake = (at: Date) =>
  sql`least(${at.toISOString()}::timestamptz, coalesce(${wakeAt}, ${at.toISOString()}::timestamptz))`;

/**
 * Queues work that waits for things to settle: scheduleJob (core) with a debounce. There's one pending job per
 * kind and key, and each call moves it to `runAt`, later or earlier, so every new message pushes the AI
 * teammate's reply back (its caller caps `runAt`: never more than 90 s after the first unanswered message). A job
 * that is running right now can't move (its runner writes the job's next state when it finishes), so the time
 * is left in its payload as `_wakeAt`, exactly as scheduleJob's pullEarlier does, and processJobs runs it again
 * then.
 */
export async function scheduleDebouncedJob(
  tx: Tx,
  job: {
    readonly kind: string;
    readonly dedupeKey: string;
    readonly runAt: Date;
    readonly payload: Record<string, unknown>;
    readonly workspaceId: string | null;
    readonly organizationId: string | null;
  },
): Promise<void> {
  const running = sql`(app.scheduled_jobs.locked_at is not null and app.scheduled_jobs.run_at <= now())`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${job.organizationId}, ${job.workspaceId}, ${job.kind}, ${job.dedupeKey},
          ${job.runAt.toISOString()}::timestamptz, ${JSON.stringify(job.payload)}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do update set
          run_at = case when ${running} then app.scheduled_jobs.run_at else excluded.run_at end,
          payload = case when ${running}
            then app.scheduled_jobs.payload || jsonb_build_object('_wakeAt', least(
              coalesce((app.scheduled_jobs.payload ->> '_wakeAt')::timestamptz, excluded.run_at), excluded.run_at))
            else app.scheduled_jobs.payload end`,
  );
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
    const finish = (set: PgUpdateSetSource<typeof scheduledJobs>) =>
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
        await finish({
          runAt: notLaterThanWake(result.rescheduleAt),
          payload: withoutWake,
          lastError: null,
        });
        stats.rescheduled++;
      } else {
        await finish({
          status: sql`(case when ${wakeAt} is null then 'done' else 'pending' end)::app.job_status`,
          runAt: sql`coalesce(${wakeAt}, ${scheduledJobs.runAt})`,
          finishedAt: sql`case when ${wakeAt} is null then now() end`,
          payload: withoutWake,
          lastError: null,
        });
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
        runAt: notLaterThanWake(new Date(Date.now() + backoffMs(attempts))),
        payload: withoutWake,
        lastError: message.slice(0, 2000),
        ...(failed ? { finishedAt: new Date() } : {}),
      });
      if (failed) stats.failed++;
      else stats.retried++;
    }
  }
  return stats;
}
