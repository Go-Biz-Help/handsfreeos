/**
 * Whether phones keep a job (docs/contractor.md, "On the phone"). Phones keep every open job, and one that's done or
 * cancelled for a month after, so yesterday's work is still there to look back at and a year of old jobs isn't
 * carried around. Taking a job off phones takes its work orders, materials, time and notes with it (they follow its
 * record); marking it in progress again puts them all back.
 *
 * A job's status changing sets it now and, for one that closed, books a look a month later. Both are safe to run
 * again: they read where the job stands and set what that says.
 */
import { leavesPhonesAt, type JobStatus } from '@hfos/core/addons/contractor/progress';
import { asWorker, rows, sql } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const PHONE_CHECK = 'contractor.phone_check';

/** A check never waits less than this: neither the clock nor the queue is exact. */
const SLACK_MS = 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** Sets whether phones keep the job now. Answers when to look again, or null when there's nothing more to do. */
async function look(ctx: AddonScopeContext, jobId: string, now: number): Promise<number | null> {
  const [job] = await asWorker(ctx.db, ctx.scope, (tx) =>
    rows<{ status: JobStatus; status_at: Date | string }>(
      tx,
      sql`select status, status_at from addon_contractor.jobs
          where record_id = ${jobId}::uuid and workspace_id = ${ctx.scope.workspaceId}::uuid`,
    ),
  );
  if (!job) return null;
  const leaves = leavesPhonesAt({
    status: job.status,
    statusAt: new Date(job.status_at).getTime(),
  });
  const keep = leaves === null || now < leaves;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    rows(
      tx,
      sql`select private.record_phone_window(${ctx.scope.workspaceId}::uuid, ${jobId}::uuid, ${keep})`,
    ),
  );
  return keep ? leaves : null;
}

/** A job's status changed: phones keep it or not from now, and a job that closed is looked at again in a month. */
export async function jobStatusMoved(ctx: AddonEventContext): Promise<void> {
  const payload = (ctx.event.payload ?? {}) as Record<string, unknown>;
  const jobId = str(payload['jobId']) ?? ctx.event.entityId;
  if (!jobId) return;
  const next = await look(ctx, jobId, Date.now());
  if (next === null) return;
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: PHONE_CHECK,
        dedupeKey: `phone:${jobId}`,
        runAt: new Date(Math.max(next, Date.now() + SLACK_MS)),
        payload: { jobId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
    ),
  );
}

/** `contractor.phone_check`: a job that closed a month ago leaves phones, unless it was opened again since. */
export async function phoneCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const jobId = str(ctx.job.payload['jobId']);
  if (!jobId) return;
  const next = await look(ctx, jobId, ctx.now);
  if (next !== null) return { rescheduleAt: new Date(Math.max(next, ctx.now + SLACK_MS)) };
}
