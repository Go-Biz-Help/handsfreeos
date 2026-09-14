/**
 * What the engine does when people change a workflow or its runs (the workflow commands emit these; people
 * can't start runs, set the tested revision, or cancel approvals and jobs themselves):
 * - enrol requested (a customer page, the Assistant, bulk): start the run.
 * - test requested: a test run of the draft, unless the draft moved on since (recorded as outdated).
 * - Retry and Skip on a failed step: revive the run.
 * - an approval decided: pull the run's job forward.
 * - contact removed, a run stopped, archived: stop runs the person couldn't, cancel approvals and jobs.
 * - paused: nothing now (runs hold at their next step). Resumed: release held runs in batches.
 * - published: arm the schedule, or make the inbound webhook, as the trigger needs.
 */
import { parseStoredDefinition, scheduleJob, type WorkflowDefinition } from '@hfos/core/server';
import { asWorker, rows, sql, type Tx } from '@hfos/db/client';
import { workflowRuns } from '@hfos/db/schema';
import type { HandlerContext } from '../handlers/types';
import type { JobHandler } from '../jobs';
import { tenantOf, type TenantScope } from '../services';
import { BATCH, JOB, releaseJobKey, scheduleJobKey, SPREAD_MS } from './constants';
import { versionDefinition } from './defs';
import { enrol } from './enrol';
import { recordEngineEvent } from './events';
import { cancelRunWork, stopRuns, wakeRun } from './runs';
import { armSchedule } from './triggers';
import { ensureWebhook } from './webhooks';

export const LIFECYCLE_EVENTS = [
  'workflow.enrol_requested',
  'workflow.test_requested',
  'workflow.step_retry_requested',
  'workflow.step_skip_requested',
  'workflow.approval_decided',
  'workflow.contact_removed',
  'workflow_run.stopped',
  'workflow.archived',
  'workflow.paused',
  'workflow.resumed',
  'workflow.published',
] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

interface FlowRow extends Record<string, unknown> {
  id: string;
  name: string;
  status: string;
  version: string | null;
  revision: number;
  definition: unknown;
}

async function flow(tx: Tx, workspaceId: string, id: string | null): Promise<FlowRow | null> {
  if (!id) return null;
  const [w] = await rows<FlowRow>(
    tx,
    sql`select id, name, status::text as status, active_version_id as version, revision, definition
        from app.workflows where id = ${id} and workspace_id = ${workspaceId}`,
  );
  return w ?? null;
}

function triggerLabel(def: WorkflowDefinition): string {
  return def.trigger.kind === 'event' ? def.trigger.event : def.trigger.kind;
}

async function enrolRequested(ctx: HandlerContext, scope: TenantScope, p: Record<string, unknown>) {
  const wf = await flow(ctx.tx, scope.workspaceId, str(p['workflowId']));
  const personId = str(p['personId']);
  if (!wf || wf.status !== 'active' || !wf.version || !personId) {
    ctx.log.info(
      { workflowId: p['workflowId'] },
      'enrol request for a workflow that isn’t live; ignored',
    );
    return;
  }
  const def = await versionDefinition(ctx.tx, wf.version);
  await enrol(ctx.tx, {
    scope,
    workflow: { id: wf.id, name: wf.name },
    versionId: wf.version,
    def,
    personId,
    triggerEventId: ctx.event.id,
    dedupeKey: `manual:${ctx.event.id}`,
    startedBy: str(p['requestedBy']),
    context: { trigger: { event: 'manual', requestedBy: str(p['requestedBy']) } },
    log: ctx.log,
  });
}

/** The records a test's sample customer brings: their newest lead, appointment and conversation. */
async function sampleRecords(tx: Tx, workspaceId: string, personId: string | null) {
  if (!personId) return { leadId: null, appointmentId: null, conversationId: null };
  const [l] = await rows<{ id: string }>(
    tx,
    sql`select id from app.leads where workspace_id = ${workspaceId} and person_id = ${personId} and archived_at is null
        order by created_at desc limit 1`,
  );
  const [a] = await rows<{ id: string }>(
    tx,
    sql`select a.id from app.appointments a join app.appointment_attendees t on t.appointment_id = a.id
        where a.workspace_id = ${workspaceId} and t.person_id = ${personId}
        order by a.starts_at desc limit 1`,
  );
  const [c] = await rows<{ id: string }>(
    tx,
    sql`select id from app.conversations where workspace_id = ${workspaceId} and person_id = ${personId}
        order by last_message_at desc nulls last limit 1`,
  );
  return { leadId: l?.id ?? null, appointmentId: a?.id ?? null, conversationId: c?.id ?? null };
}

async function testRequested(ctx: HandlerContext, scope: TenantScope, p: Record<string, unknown>) {
  const e = ctx.event;
  const wf = await flow(ctx.tx, scope.workspaceId, str(p['workflowId']));
  if (!wf) return;
  const revision = Number(p['revision']);
  const mode = p['mode'] === 'send_to_me' ? ('send_to_me' as const) : ('simulate' as const);
  const personId = str(p['personId']);
  const requestedBy = str(p['requestedBy']);
  const definition = (isRecord(wf.definition) ? wf.definition : {}) as Record<string, unknown>;
  if (wf.revision !== revision || wf.status === 'archived' || !Number.isInteger(revision)) {
    // The draft moved on (or went away) before the test ran: it's recorded, and it can't open Publish.
    const [row] = await ctx.tx
      .insert(workflowRuns)
      .values({
        workspaceId: scope.workspaceId,
        workflowId: wf.id,
        testRevision: Number.isInteger(revision) && revision >= 1 ? revision : wf.revision,
        testDefinition: definition,
        status: 'stopped',
        isTest: true,
        testMode: mode,
        startedBy: requestedBy,
        personId,
        triggerEventId: e.id,
        dedupeKey: `test:${e.id}`,
        context: { requestedRevision: revision, currentRevision: wf.revision },
        endReason: 'outdated',
        endedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: workflowRuns.id });
    if (row)
      await recordEngineEvent(ctx.tx, {
        type: 'workflow_run.ended',
        action: 'workflow_run.end',
        workspaceId: scope.workspaceId,
        organizationId: scope.organizationId,
        entityType: 'workflow_run',
        entityId: row.id,
        actor: { type: 'workflow', workflowId: wf.id },
        correlationId: row.id,
        causationId: e.id,
        payload: {
          runId: row.id,
          workflowId: wf.id,
          personId,
          status: 'stopped',
          reason: 'outdated',
          isTest: true,
        },
        after: {
          status: 'stopped',
          reason: 'outdated',
          requestedRevision: revision,
          currentRevision: wf.revision,
        },
      });
    return;
  }
  let def: WorkflowDefinition;
  try {
    def = parseStoredDefinition(wf.definition);
  } catch {
    ctx.log.warn({ workflowId: wf.id }, 'a test was asked for a draft that can’t be read');
    return;
  }
  const records = await sampleRecords(ctx.tx, scope.workspaceId, personId);
  await enrol(ctx.tx, {
    scope,
    workflow: { id: wf.id, name: wf.name },
    versionId: null,
    def,
    personId,
    ...records,
    triggerEventId: e.id,
    dedupeKey: `test:${e.id}`,
    startedBy: requestedBy,
    context: {
      trigger: { event: triggerLabel(def), test: true },
      assume: isRecord(p['assume']) ? p['assume'] : {},
    },
    test: { mode, revision, definition },
    log: ctx.log,
  });
}

/** Retry or Skip on the failed step a run is on: the step is ready again (or skipped) and the run revived. */
async function stepRequest(
  ctx: HandlerContext,
  scope: TenantScope,
  p: Record<string, unknown>,
  kind: 'retry' | 'skip',
) {
  const runId = str(p['runId']);
  const stepKey = str(p['stepKey']);
  if (!runId || !stepKey) return;
  const [run] = await rows<{
    id: string;
    status: string;
    cursor: string | null;
    visits: Record<string, number>;
    workflow_id: string;
    enrol_key: string | null;
    is_test: boolean;
  }>(
    ctx.tx,
    sql`select id, status::text as status, cursor, visits, workflow_id, enrol_key, is_test
        from app.workflow_runs where id = ${runId} and workspace_id = ${scope.workspaceId} for update`,
  );
  if (!run || run.status === 'completed' || run.status === 'stopped' || !run.cursor) return;
  if (`${run.cursor}#${run.visits[run.cursor] ?? 1}` !== stepKey) {
    ctx.log.info({ runId, stepKey }, 'Retry or Skip for a step the run isn’t on; ignored');
    return;
  }
  const [step] = await rows<{ id: string; status: string; output: Record<string, unknown> | null }>(
    ctx.tx,
    sql`select id, status::text as status, output from app.workflow_run_steps where run_id = ${runId} and step_key = ${stepKey}`,
  );
  if (!step || (step.status !== 'failed' && step.status !== 'dead')) return;
  if (run.status === 'failed' && run.enrol_key && !run.is_test) {
    // Reviving it must not make a second live run for the same customer.
    const other = await rows(
      ctx.tx,
      sql`select 1 from app.workflow_runs
          where workflow_id = ${run.workflow_id} and enrol_key = ${run.enrol_key} and id <> ${run.id} and not is_test
            and status in ('running', 'waiting', 'awaiting_approval', 'held') limit 1`,
    );
    if (other.length) {
      ctx.log.info(
        { runId },
        'the customer is already in a newer run of this workflow; not reviving',
      );
      return;
    }
  }
  const by = str(p['requestedBy']);
  const retries =
    typeof step.output?.['manualRetries'] === 'number' ? step.output['manualRetries'] : 0;
  if (kind === 'retry')
    await ctx.tx.execute(
      sql`update app.workflow_run_steps
          set status = 'failed',
            output = coalesce(output, '{}'::jsonb) || ${JSON.stringify({
              manualRetries: step.status === 'dead' ? retries + 1 : retries,
              retryRequestedBy: by,
            })}::jsonb
          where id = ${step.id}`,
    );
  else
    await ctx.tx.execute(
      sql`update app.workflow_run_steps
          set status = 'skipped', next_step_key = null, finished_at = now(),
            output = coalesce(output, '{}'::jsonb) || ${JSON.stringify({ skipped: 'by_person', skippedBy: by })}::jsonb
          where id = ${step.id}`,
    );
  await ctx.tx.execute(
    sql`update app.workflow_runs set status = 'running', ended_at = null, end_reason = null where id = ${runId}`,
  );
  await wakeRun(ctx.tx, scope, runId);
}

async function published(ctx: HandlerContext, scope: TenantScope, p: Record<string, unknown>) {
  const workflowId = ctx.event.entityId;
  const versionId = str(p['versionId']);
  if (!workflowId || !versionId) return;
  const def = await versionDefinition(ctx.tx, versionId);
  await armSchedule(ctx.tx, scope, workflowId, versionId, def, Date.now());
  if (def.trigger.kind === 'webhook')
    await ensureWebhook(
      ctx.tx,
      ctx.sealer,
      scope,
      workflowId,
      ctx.event.actorType === 'human' ? ctx.event.actorId : null,
    );
}

async function archived(ctx: HandlerContext, p: Record<string, unknown>) {
  const workflowId = ctx.event.entityId;
  await cancelRunWork(ctx.tx, strings(p['stoppedRunIds']));
  if (!workflowId) return;
  await ctx.tx.execute(
    sql`update app.scheduled_jobs set status = 'cancelled', finished_at = now()
        where status = 'pending' and workspace_id = ${ctx.event.workspaceId}
          and ((kind = ${JOB.schedule} and dedupe_key = ${scheduleJobKey(workflowId)})
            or (kind = ${JOB.release} and dedupe_key = ${releaseJobKey(workflowId)})
            or (kind = ${JOB.date} and dedupe_key like ${`date:${workflowId}:%`}))`,
  );
}

/** Handles the engine's own events; false for anything else. */
export async function onLifecycleEvent(ctx: HandlerContext, scope: TenantScope): Promise<boolean> {
  const e = ctx.event;
  const p = isRecord(e.payload) ? e.payload : {};
  switch (e.eventType) {
    case 'workflow.enrol_requested':
      await enrolRequested(ctx, scope, p);
      return true;
    case 'workflow.test_requested':
      await testRequested(ctx, scope, p);
      return true;
    case 'workflow.step_retry_requested':
      await stepRequest(ctx, scope, p, 'retry');
      return true;
    case 'workflow.step_skip_requested':
      await stepRequest(ctx, scope, p, 'skip');
      return true;
    case 'workflow.approval_decided': {
      const runId = str(p['runId']);
      if (runId) await wakeRun(ctx.tx, scope, runId);
      return true;
    }
    case 'workflow.contact_removed': {
      const runIds = strings(p['runIds']);
      // Members can't stop runs under RLS: their removals are finished here.
      if (p['pending'] === true) await stopRuns(ctx.tx, scope, runIds, 'removed_from_workflow');
      await cancelRunWork(ctx.tx, runIds);
      return true;
    }
    case 'workflow_run.stopped': {
      const runId = str(p['runId']);
      if (runId) await cancelRunWork(ctx.tx, [runId]);
      return true;
    }
    case 'workflow.archived':
      await archived(ctx, p);
      return true;
    case 'workflow.paused':
      return true;
    case 'workflow.resumed':
      if (e.entityId)
        await scheduleJob(
          ctx.tx,
          {
            kind: JOB.release,
            dedupeKey: releaseJobKey(e.entityId),
            runAt: new Date(),
            payload: { workflowId: e.entityId },
            workspaceId: scope.workspaceId,
            organizationId: scope.organizationId,
          },
          { pullEarlier: true },
        );
      return true;
    case 'workflow.published':
      await published(ctx, scope, p);
      return true;
    default:
      return false;
  }
}

/** After Resume: held runs go again, a batch at a time, their starts spread over a minute. */
export const workflowReleaseJob: JobHandler = async (ctx) => {
  const scope = tenantOf(ctx.scope);
  const workflowId = String(ctx.job.payload['workflowId'] ?? '');
  return asWorker(ctx.db, scope, async (tx) => {
    const [wf] = await rows<{ status: string }>(
      tx,
      sql`select status::text as status from app.workflows where id = ${workflowId}`,
    );
    if (wf?.status !== 'active') return;
    const held = await rows<{ id: string }>(
      tx,
      sql`select id from app.workflow_runs where workflow_id = ${workflowId} and status = 'held'
          order by started_at limit ${BATCH} for update skip locked`,
    );
    for (const [i, r] of held.entries()) {
      await tx.execute(sql`update app.workflow_runs set status = 'running' where id = ${r.id}`);
      await wakeRun(tx, scope, r.id, new Date(Date.now() + Math.floor((i * SPREAD_MS) / BATCH)));
    }
    return held.length === BATCH ? { rescheduleAt: new Date(Date.now() + SPREAD_MS) } : undefined;
  });
};
