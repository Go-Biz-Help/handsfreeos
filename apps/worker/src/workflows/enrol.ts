/**
 * Starting a run. One insert settles every race: `on conflict do nothing` against the workflow's unique
 * dedupe key (one run per trigger, so an outbox retry or a replayed webhook lands on the same row) and the
 * re-entry indexes (enrol_key: one live run per customer; once_key: one run per customer ever). "Always"
 * has neither key, only a cooldown, checked under an advisory lock. Tests never take a key. Then the run's
 * cursor job is queued.
 */
import { durationMinutes, scheduleJob, type WorkflowDefinition } from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { workflowRuns } from '@hfos/db/schema';
import type { Logger } from 'pino';
import type { TenantScope } from '../services';
import { JOB, LIVE_STATUSES, MAX_LIVE_RUNS, runJobKey } from './constants';
import { recordEngineEvent } from './events';

export interface EnrolInput {
  readonly scope: TenantScope;
  readonly workflow: { readonly id: string; readonly name: string };
  /** The published version (null for a test of the draft). */
  readonly versionId: string | null;
  readonly def: WorkflowDefinition;
  readonly personId: string | null;
  readonly leadId?: string | null;
  readonly appointmentId?: string | null;
  readonly conversationId?: string | null;
  readonly triggerEventId?: string | null;
  /** One run per trigger: the event and person, the delivery, the schedule occurrence… */
  readonly dedupeKey: string;
  readonly depth?: number;
  readonly originRunId?: string | null;
  readonly context?: Record<string, unknown>;
  readonly startedBy?: string | null;
  /** When the run's first step goes (default now; batches spread their starts). */
  readonly startAt?: Date;
  readonly test?: {
    readonly mode: 'simulate' | 'send_to_me';
    readonly revision: number;
    readonly definition: Record<string, unknown>;
  };
  readonly log?: Logger;
}

export type EnrolResult =
  { readonly runId: string } | { readonly skipped: 'already' | 'cooldown' | 'run_limit' };

export async function enrol(tx: Tx, input: EnrolInput): Promise<EnrolResult> {
  const { scope, def, workflow } = input;
  const test = input.test ?? null;
  if (!test) {
    const [live] = await rows<{ n: number }>(
      tx,
      sql`select count(*)::int as n from (
            select 1 from app.workflow_runs
            where workflow_id = ${workflow.id} and not is_test
              and status in (${sql.join(
                LIVE_STATUSES.map((s) => sql`${s}::app.workflow_run_status`),
                sql`, `,
              )})
            limit ${MAX_LIVE_RUNS}) x`,
    );
    if ((live?.n ?? 0) >= MAX_LIVE_RUNS) {
      input.log?.warn(
        { workflowId: workflow.id, limit: MAX_LIVE_RUNS },
        'workflow has too many runs going; not starting another',
      );
      return { skipped: 'run_limit' };
    }
  }

  const reentry = def.settings.reentry;
  const person = input.personId;
  const keyed = !test && person !== null;
  if (keyed && reentry.mode === 'always') {
    // Two events at once for the same customer: the second waits here and then sees the first's run.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`wf-enrol:${workflow.id}:${person}`}))`,
    );
    const recent = await rows(
      tx,
      sql`select 1 from app.workflow_runs
          where workflow_id = ${workflow.id} and person_id = ${person} and not is_test
            and started_at > now() - make_interval(mins => ${durationMinutes(reentry.cooldown)})
          limit 1`,
    );
    if (recent.length) return { skipped: 'cooldown' };
  }

  const first = def.steps[0]?.id ?? null;
  const [row] = await tx
    .insert(workflowRuns)
    .values({
      workspaceId: scope.workspaceId,
      workflowId: workflow.id,
      versionId: input.versionId,
      testRevision: test?.revision ?? null,
      testDefinition: test?.definition ?? null,
      status: 'running',
      isTest: !!test,
      testMode: test?.mode ?? null,
      startedBy: input.startedBy ?? null,
      personId: person,
      leadId: input.leadId ?? null,
      appointmentId: input.appointmentId ?? null,
      conversationId: input.conversationId ?? null,
      triggerEventId: input.triggerEventId ?? null,
      dedupeKey: input.dedupeKey.slice(0, 300),
      enrolKey: keyed && reentry.mode === 'after_exit' ? person : null,
      onceKey: keyed && reentry.mode === 'once' ? person : null,
      context: input.context ?? {},
      cursor: first,
      visits: first ? { [first]: 1 } : {},
      stopOn: test ? [] : [...def.settings.stopOn],
      originRunId: input.originRunId ?? null,
      depth: input.depth ?? 0,
    })
    .onConflictDoNothing()
    .returning({ id: workflowRuns.id });
  if (!row) return { skipped: 'already' };

  await scheduleJob(
    tx,
    {
      kind: JOB.step,
      dedupeKey: runJobKey(row.id),
      runAt: input.startAt ?? new Date(),
      payload: { runId: row.id },
      workspaceId: scope.workspaceId,
      organizationId: scope.organizationId,
    },
    { pullEarlier: true },
  );
  await recordEngineEvent(tx, {
    type: 'workflow_run.started',
    action: 'workflow_run.start',
    workspaceId: scope.workspaceId,
    organizationId: scope.organizationId,
    entityType: 'workflow_run',
    entityId: row.id,
    actor: { type: 'workflow', workflowId: workflow.id },
    correlationId: row.id,
    causationId: input.triggerEventId ?? null,
    payload: {
      runId: row.id,
      workflowId: workflow.id,
      personId: person,
      isTest: !!test,
      testMode: test?.mode ?? null,
      depth: input.depth ?? 0,
      startedBy: input.startedBy ?? null,
    },
    after: { workflow: workflow.name, ...(test ? { test: test.mode } : {}) },
  });
  return { runId: row.id };
}
