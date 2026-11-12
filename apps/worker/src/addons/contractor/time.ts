/**
 * Time on a job, in the worker (docs/contractor.md, "Time and job costing"; the owner's decision 10).
 *
 * - **The buttons.** Each of core's `job.status_changed` on a visit, and a visit cancelled, goes to
 *   `contractor.time.follow_status` with the moment it really happened (the phone's, when it was pressed with no
 *   signal) and who pressed it. The command decides what starts and stops, and is safe to run again.
 * - **`contractor.time_check`**: one job per visit with time running, for the moment its oldest stretch has run
 *   the limit. It stops what's over, tells the people who may fix time (an alert on Home and their phones, never
 *   with an amount), and waits for the next. The alert comes down once nothing stopped that way is left to look at.
 * - **What an hour cost** is put on time as the system (`contractor.time.stamp_costs`), because the people who
 *   track and fix time mostly can't see costs: after a break, a fix, time added, a person's cost per hour set, and
 *   Estimating's labor cost set.
 *
 * Everything here is safe to run again: the commands do nothing the second time, the check's key is the visit's,
 * and raising an alert again only updates it.
 */
import {
  timeFollowStatus,
  timeStampCosts,
  timeStopOverrun,
} from '@hfos/core/addons/contractor/ops/time';
import { timeStoppedAlertWords } from '@hfos/core/addons/contractor/words';
import { executeCommand } from '@hfos/core/server';
import { asWorker } from '@hfos/db/client';
import type { JobResult } from '../../jobs';
import { clearAddonAlert, raiseAddonAlert } from '../alerts';
import { scheduleAddonJob } from '../queue';
import type { AddonEventContext, AddonJobContext, AddonScopeContext } from '../types';

export const TIME_CHECK = 'contractor.time_check';

const keyOf = (appointmentId: string) => `time:${appointmentId}`;
/** A check never waits less than this: neither the clock nor the queue is exact. */
const SLACK_MS = 60_000;

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const payloadOf = (ctx: AddonEventContext) => (ctx.event.payload ?? {}) as Record<string, unknown>;
/** When it really happened: the phone's moment for something pressed with no signal. */
const momentOf = (ctx: AddonEventContext) =>
  (ctx.event.occurredAt ?? ctx.event.createdAt).toISOString();

async function follow(
  ctx: AddonEventContext,
  appointmentId: string,
  status: string,
): Promise<void> {
  await executeCommand(
    ctx.db,
    timeFollowStatus,
    {
      workspaceId: ctx.scope.workspaceId,
      appointmentId,
      status,
      at: momentOf(ctx),
      // With nobody on the visit, the time is whoever pressed the button's.
      ...(ctx.event.actorType === 'human' && ctx.event.actorId
        ? { byUserId: ctx.event.actorId }
        : {}),
    },
    ctx.actor,
    ctx.meta,
  );
}

/** Core's `job.status_changed`: a visit's status button was pressed. A note alone moves no clock. */
export async function visitStatusMoved(ctx: AddonEventContext): Promise<void> {
  const p = payloadOf(ctx);
  const appointmentId = str(p['appointmentId']) ?? ctx.event.entityId;
  const status = str(p['status']);
  if (!appointmentId || !status || p['statusChanged'] === false) return;
  await follow(ctx, appointmentId, status);
}

/** A visit was cancelled (or put in the Deleted bin): whatever was running on it stops there. */
export async function visitCancelledTime(ctx: AddonEventContext): Promise<void> {
  if (ctx.event.entityId) await follow(ctx, ctx.event.entityId, 'cancelled');
}

/**
 * Looks at one visit's time: stops what has run the limit, keeps the alert for the people who may fix time true to
 * what's still waiting for a look, and says when the next stretch still running reaches the limit.
 */
async function check(ctx: AddonScopeContext, appointmentId: string): Promise<number | null> {
  const { output: out } = await executeCommand(
    ctx.db,
    timeStopOverrun,
    { workspaceId: ctx.scope.workspaceId, appointmentId },
    ctx.actor,
    ctx.meta,
  );
  if (out.jobId && out.job && out.flagged.length) {
    const words = timeStoppedAlertWords({ job: out.job, names: out.flagged });
    await raiseAddonAlert(ctx, {
      key: keyOf(appointmentId),
      severity: 'attention',
      title: words.title,
      detail: words.detail,
      href: `/a/contractor/jobs/${out.jobId}`,
      permission: 'contractor.fix_time',
      customRecordId: out.jobId,
    });
  } else await clearAddonAlert(ctx, keyOf(appointmentId), 'done');
  return out.nextAt ? new Date(out.nextAt).getTime() : null;
}

async function arm(ctx: AddonScopeContext, appointmentId: string, at: number): Promise<void> {
  await asWorker(ctx.db, ctx.scope, (tx) =>
    scheduleAddonJob(
      tx,
      { id: ctx.manifest.id, generation: ctx.generation },
      {
        kind: TIME_CHECK,
        dedupeKey: keyOf(appointmentId),
        runAt: new Date(Math.max(at, Date.now() + SLACK_MS)),
        payload: { appointmentId },
        workspaceId: ctx.scope.workspaceId,
        organizationId: ctx.scope.organizationId,
      },
      { pullEarlier: true },
    ),
  );
}

/** `contractor.time_check`: a stretch on the visit may have run the limit. */
export async function timeCheckJob(ctx: AddonJobContext): Promise<JobResult> {
  const appointmentId = str(ctx.job.payload['appointmentId']);
  if (!appointmentId) return;
  const next = await check(ctx, appointmentId);
  if (next !== null) return { rescheduleAt: new Date(Math.max(next, ctx.now + SLACK_MS)) };
}

/**
 * The time on a visit changed (the buttons, a fix, a removal): its check waits for the next stretch to reach the
 * limit, and its alert comes down when the last stretch stopped on its own has been looked at.
 */
export async function visitTimeChanged(ctx: AddonEventContext): Promise<void> {
  const appointmentId = str(payloadOf(ctx)['appointmentId']);
  if (!appointmentId) return;
  const next = await check(ctx, appointmentId);
  if (next !== null) await arm(ctx, appointmentId, next);
}

const stamp = (ctx: AddonEventContext, only: { jobId?: string; userId?: string }) =>
  executeCommand(
    ctx.db,
    timeStampCosts,
    { workspaceId: ctx.scope.workspaceId, ...only },
    ctx.actor,
    ctx.meta,
  );

/** Time on a job changed hands, kind or length: any of it with no cost yet gets what its hour costs. */
export async function jobTimeChanged(ctx: AddonEventContext): Promise<void> {
  const jobId = str(payloadOf(ctx)['jobId']) ?? ctx.event.entityId;
  if (jobId) await stamp(ctx, { jobId });
  await visitTimeChanged(ctx);
}

/** A person's cost per hour was set: their time that had none gets it. What already had a cost keeps it. */
export async function laborRateSet(ctx: AddonEventContext): Promise<void> {
  const userId = str(payloadOf(ctx)['userId']) ?? ctx.event.entityId;
  if (userId) await stamp(ctx, { userId });
}

/** Estimating was saved, maybe with a labor cost per hour: time with no cost and nobody's own rate gets it. */
export async function estimatingSaved(ctx: AddonEventContext): Promise<void> {
  await stamp(ctx, {});
}
