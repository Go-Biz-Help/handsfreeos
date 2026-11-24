import { and, eq } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { asWorker, rows, sql, type SystemScope, type Tx } from '@hfos/db/client';
import { scheduledJobs } from '@hfos/db/schema';
import { backoffMs, errorMessage, MAX_ATTEMPTS } from './outbox';
import { forPractice } from './practice/kit';
import { inPractice, practiceRunFor } from './practice/scope';
import type { WorkerServices } from './services';
import { renewAfterRefusal } from './telephony/tokens';

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
  /**
   * Told after each job's handler ran, whatever came of it. What it did may have left an event for the outbox or
   * another job due now: main.ts wakes those loops, so neither waits for the next poll.
   */
  readonly onRan?: () => void;
}

export interface JobStats {
  claimed: number;
  done: number;
  rescheduled: number;
  retried: number;
  failed: number;
  /** An add-on's jobs that came up while it was off, or queued before it was reinstalled: never run. */
  cancelled: number;
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
    /**
     * Merge this payload into a pending job's (its keys win), instead of keeping the pending job's as it was: a
     * workflow's hand-over puts its goal and loop guard on a reply that was already waiting.
     */
    readonly mergePayload?: boolean;
  },
): Promise<void> {
  const running = sql`(app.scheduled_jobs.locked_at is not null and app.scheduled_jobs.run_at <= now())`;
  const pendingPayload = job.mergePayload
    ? sql`app.scheduled_jobs.payload || excluded.payload`
    : sql`app.scheduled_jobs.payload`;
  await tx.execute(
    sql`insert into app.scheduled_jobs (organization_id, workspace_id, kind, dedupe_key, run_at, payload)
        values (${job.organizationId}, ${job.workspaceId}, ${job.kind}, ${job.dedupeKey},
          ${job.runAt.toISOString()}::timestamptz, ${JSON.stringify(job.payload)}::jsonb)
        on conflict (kind, dedupe_key) where status = 'pending' and dedupe_key is not null do update set
          run_at = case when ${running} then app.scheduled_jobs.run_at else excluded.run_at end,
          payload = case when ${running}
            then app.scheduled_jobs.payload || jsonb_build_object('_wakeAt', least(
              coalesce((app.scheduled_jobs.payload ->> '_wakeAt')::timestamptz, excluded.run_at), excluded.run_at))
            else ${pendingPayload} end`,
  );
}

/**
 * A job a worker may claim now: due, and not inside another worker's five-minute lease. The claims below and the
 * one look a second that paces the loops (queues.ts) ask with these same words, so they can't disagree.
 *
 * A row this worker already holds counts too: one that an earlier pass of its own left behind (a pass that broke
 * off, a restart under the same name). The runner that keeps several jobs going (job-runner.ts) leaves out the
 * ones it is running.
 */
export const claimableJobs = (workerId: string) =>
  sql`status = 'pending' and run_at <= now()
      and (locked_at is null or locked_at < now() - interval '5 minutes' or locked_by = ${workerId})`;

const noStats = (): JobStats => ({
  claimed: 0,
  done: 0,
  rescheduled: 0,
  retried: 0,
  failed: 0,
  cancelled: 0,
});

/** What became of a claimed job. `lost`: when its turn came, its lease was no longer this worker's. */
export type JobOutcome = 'done' | 'rescheduled' | 'retried' | 'failed' | 'cancelled' | 'lost';

/**
 * Runs one job this worker has claimed, and writes what came of it. Nothing here throws for the job's own
 * failure: that is an outcome (`retried`, `failed`).
 */
export async function runClaimed(
  deps: Omit<JobDeps, 'batchSize' | 'reservedOnly'>,
  id: string,
): Promise<JobOutcome> {
  // Ours only while the lease holds: a row still waiting its turn after the rows before it ran for five minutes
  // can be claimed by another worker, and must then run there, not twice.
  const ours = and(eq(scheduledJobs.id, id), eq(scheduledJobs.lockedBy, deps.workerId));
  // Read as its turn comes, and the lease renewed from now for the handler's own five minutes. An add-on's job
  // also asks, in the same transaction, whether its add-on still runs here at the generation it was queued for;
  // core's jobs ask nothing, so add-ons cost them nothing.
  const { job, addonRuns } = await asWorker(deps.db, {}, async (tx) => {
    const [row] = await tx
      .update(scheduledJobs)
      .set({ lockedAt: sql`now()` })
      .where(and(ours, eq(scheduledJobs.status, 'pending')))
      .returning();
    if (!row?.addonId) return { job: row, addonRuns: true };
    const [check] = await rows<{ ok: boolean }>(
      tx,
      sql`select private.addon_runs_now(${row.workspaceId}::uuid, ${row.addonId}, ${row.addonGeneration}::integer) as ok`,
    );
    return { job: row, addonRuns: check?.ok === true };
  });
  if (!job) return 'lost';
  const handler = deps.jobs[job.kind];
  const finish = (set: PgUpdateSetSource<typeof scheduledJobs>) =>
    asWorker(deps.db, {}, (tx) =>
      tx
        .update(scheduledJobs)
        .set({ ...set, lockedAt: null, lockedBy: null })
        .where(ours),
    );
  // Turned off, uninstalled or reinstalled since: it never runs, and nothing it would have sent goes out late
  // (the owner's decision, 2026-09-28). Nor does an add-on job this build has no code for.
  if (job.addonId && (!addonRuns || !handler)) {
    await finish({
      status: 'cancelled',
      lastError: addonRuns ? `no handler for ${job.kind}` : 'addon_inactive',
      finishedAt: new Date(),
    });
    return 'cancelled';
  }
  if (!handler) {
    await finish({
      status: 'failed',
      lastError: `no handler for ${job.kind}`,
      finishedAt: new Date(),
    });
    return 'failed';
  }
  let outcome: JobOutcome;
  try {
    // A practice business's jobs run with its stand-ins (practice/kit.ts): nothing goes outside.
    const run = await practiceRunFor(deps.db, {
      organizationId: job.organizationId,
      workspaceId: job.workspaceId,
    });
    const result = await inPractice(run, () =>
      handler({
        ...forPractice(deps, run),
        job,
        scope: { workspaceId: job.workspaceId, organizationId: job.organizationId },
        attempt: job.attempts + 1,
        now: deps.clock ? deps.clock(job) : Date.now(),
        log: deps.log.child({ jobId: id, kind: job.kind }),
      }),
    );
    // A run that worked starts the count of tries again: the limit is for errors in a row. Counted over a job's
    // whole life, five errors months apart (or one minute of a provider's outage) ended a recurring job for good:
    // the hourly reviews read, or a sweep like plan renewals until the next restart.
    if (result?.rescheduleAt) {
      await finish({
        runAt: notLaterThanWake(result.rescheduleAt),
        attempts: 0,
        payload: withoutWake,
        lastError: null,
      });
      outcome = 'rescheduled';
    } else {
      await finish({
        status: sql`(case when ${wakeAt} is null then 'done' else 'pending' end)::app.job_status`,
        runAt: sql`coalesce(${wakeAt}, ${scheduledJobs.runAt})`,
        finishedAt: sql`case when ${wakeAt} is null then now() end`,
        attempts: sql`case when ${wakeAt} is null then ${scheduledJobs.attempts} else 0 end`,
        payload: withoutWake,
        lastError: null,
      });
      outcome = 'done';
    }
  } catch (e) {
    const attempts = job.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    const message = errorMessage(e);
    deps.log.warn({ jobId: id, kind: job.kind, attempts, failed, err: message }, 'job failed');
    // Twilio refusing a business's own sign-in can mean its token was rotated: the retry gets the new one.
    await renewAfterRefusal(deps, e);
    await finish({
      status: failed ? 'failed' : 'pending',
      attempts,
      runAt: notLaterThanWake(new Date(Date.now() + backoffMs(attempts))),
      payload: withoutWake,
      lastError: message.slice(0, 2000),
      ...(failed ? { finishedAt: new Date() } : {}),
    });
    outcome = failed ? 'failed' : 'retried';
  }
  deps.onRan?.();
  return outcome;
}

/**
 * The queue seam: delayed and periodic work lives in app.scheduled_jobs and is claimed like the outbox.
 * pgmq (or another queue) can replace the storage later behind the same two functions.
 *
 * One pass, one job at a time: it claims a batch and runs it in order, and answers when the last one has ended.
 * The tests, the seed and Playwright's routes run jobs with this. The worker itself keeps several going at once
 * (job-runner.ts).
 */
export async function processJobs(deps: JobDeps): Promise<JobStats> {
  const stats = noStats();
  const claimed = await asWorker(deps.db, {}, (tx) =>
    rows<{ id: string }>(
      tx,
      sql`with claimed as (update app.scheduled_jobs j set locked_at = now(), locked_by = ${deps.workerId}
          where j.id in (
            select id from app.scheduled_jobs
            where ${claimableJobs(deps.workerId)}
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
    const outcome = await runClaimed(deps, id);
    if (outcome !== 'lost') stats[outcome]++;
  }
  return stats;
}
