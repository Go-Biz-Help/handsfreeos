/**
 * Ending runs and tidying up after them: the status and reason, the run's pending approvals (people can't
 * cancel one) and its cursor job, the "run ended" event, a passing test opening the publish gate, and the
 * per-workspace job that prunes old step logs.
 */
import { scheduleJob } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import type { TenantScope } from '../services';
import { JOB, LIVE_STATUSES, RETENTION_DAYS, retentionJobKey, runJobKey } from './constants';
import { recordEngineEvent } from './events';

const DAY = 86_400_000;
const LIVE_SQL = sql.join(
  LIVE_STATUSES.map((s) => sql`${s}::app.workflow_run_status`),
  sql`, `,
);
export const liveSql = LIVE_SQL;

/**
 * Pulls a run's cursor job forward (or queues one): a decision, a matching event, Retry or Skip. A job that is
 * running right now remembers the wake and runs again at it (scheduleJob and jobs.ts).
 */
export async function wakeRun(
  tx: Tx,
  scope: TenantScope,
  runId: string,
  at: Date = new Date(),
): Promise<void> {
  await scheduleJob(
    tx,
    {
      kind: JOB.step,
      dedupeKey: runJobKey(runId),
      runAt: at,
      payload: { runId },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
}

/** Pending approvals of these runs → cancelled; their cursor jobs → cancelled. */
export async function cancelRunWork(tx: Tx, runIds: readonly string[]): Promise<void> {
  if (!runIds.length) return;
  const ids = sql.join(
    runIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  await tx.execute(
    sql`update app.workflow_approvals set status = 'cancelled', decided_at = now(), via = 'system'
        where run_id in (${ids}) and status = 'pending'`,
  );
  await tx.execute(
    sql`update app.scheduled_jobs set status = 'cancelled', finished_at = now()
        where kind = ${JOB.step} and status = 'pending'
          and dedupe_key in (${sql.join(
            runIds.map((id) => sql`${runJobKey(id)}`),
            sql`, `,
          )})`,
  );
}

export interface EndedRun {
  readonly id: string;
  readonly workflowId: string;
  readonly personId: string | null;
  readonly isTest: boolean;
  readonly testRevision: number | null;
}

/**
 * Ends a run that is still going (the status changes only from a live one, so two enders can't both win).
 * `completed` clears the cursor; `stopped` and `failed` keep it on the step where it ended. Returns false when
 * the run had already ended.
 */
export async function endRun(
  tx: Tx,
  scope: TenantScope,
  run: EndedRun,
  status: 'completed' | 'stopped' | 'failed',
  reason: string,
  opts: { readonly cancelJob?: boolean } = {},
): Promise<boolean> {
  const [ended] = await rows<{ id: string }>(
    tx,
    sql`update app.workflow_runs
        set status = ${status}::app.workflow_run_status, end_reason = ${reason.slice(0, 200)}, ended_at = now(),
          waiting_for = '{}', cursor = case when ${status} = 'completed' then null else cursor end
        where id = ${run.id} and status in (${LIVE_SQL})
        returning id`,
  );
  if (!ended) return false;
  if (status !== 'completed' || opts.cancelJob) await cancelRunWork(tx, [run.id]);
  if (run.isTest && status === 'completed' && run.testRevision !== null) {
    const bad = await rows(
      tx,
      sql`select 1 from app.workflow_run_steps where run_id = ${run.id} and status in ('failed', 'dead') limit 1`,
    );
    // The worker is the only writer of tested_revision: a passing test of this exact draft opens Publish.
    if (!bad.length)
      await tx.execute(
        sql`update app.workflows
            set tested_revision = greatest(coalesce(tested_revision, 0), ${run.testRevision})
            where id = ${run.workflowId} and revision >= ${run.testRevision}`,
      );
  }
  await recordEngineEvent(tx, {
    type: 'workflow_run.ended',
    action: 'workflow_run.end',
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    entityType: 'workflow_run',
    entityId: run.id,
    actor: { type: 'workflow', workflowId: run.workflowId },
    correlationId: run.id,
    payload: {
      runId: run.id,
      workflowId: run.workflowId,
      personId: run.personId,
      status,
      reason,
      isTest: run.isTest,
    },
    after: { status, reason },
  });
  // Step logs are kept RETENTION_DAYS after a run ends; one pending job per workspace prunes them.
  await scheduleJob(tx, {
    kind: JOB.retention,
    dedupeKey: retentionJobKey(scope.workspaceId),
    runAt: new Date(Date.now() + (RETENTION_DAYS + 1) * DAY),
    payload: {},
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
  });
  return true;
}

/** Stops live runs by id (Remove from workflow, stop-on, archive clean-up); returns the ones it stopped. */
export async function stopRuns(
  tx: Tx,
  scope: TenantScope,
  runIds: readonly string[],
  reason: string,
): Promise<string[]> {
  if (!runIds.length) return [];
  const list = await rows<{
    id: string;
    workflow_id: string;
    person_id: string | null;
    is_test: boolean;
    test_revision: number | null;
  }>(
    tx,
    sql`select id, workflow_id, person_id, is_test, test_revision from app.workflow_runs
        where id in (${sql.join(
          runIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) and status in (${LIVE_SQL})
        order by id for update`,
  );
  const stopped: string[] = [];
  for (const r of list)
    if (
      await endRun(
        tx,
        scope,
        {
          id: r.id,
          workflowId: r.workflow_id,
          personId: r.person_id,
          isTest: r.is_test,
          testRevision: r.test_revision,
        },
        'stopped',
        reason,
      )
    )
      stopped.push(r.id);
  return stopped;
}

/** Deletes one workspace's step logs of runs that ended over RETENTION_DAYS ago; next due when the next one is. */
export async function pruneStepLogs(tx: Tx, workspaceId: string): Promise<Date | null> {
  await tx.execute(
    sql`delete from app.workflow_run_steps s using app.workflow_runs r
        where s.run_id = r.id and r.workspace_id = ${workspaceId}
          and r.ended_at < now() - make_interval(days => ${RETENTION_DAYS})`,
  );
  const [next] = await rows<{ at: string | null }>(
    tx,
    sql`select min(r.ended_at) as at from app.workflow_runs r
        where r.workspace_id = ${workspaceId} and r.ended_at is not null
          and exists (select 1 from app.workflow_run_steps s where s.run_id = r.id)`,
  );
  return next?.at ? new Date(new Date(next.at).getTime() + (RETENTION_DAYS + 1) * DAY) : null;
}
