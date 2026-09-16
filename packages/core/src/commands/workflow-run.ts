/**
 * People and runs: add a customer to a workflow (a request the engine answers, since only it starts runs),
 * take them out, stop a run, answer an approval (claimed once), and retry or skip a failed step (requests
 * the engine answers). Everything else about a run is the engine's.
 */
import { and, eq, inArray, sql as dsql } from 'drizzle-orm';
import { workflowApprovals, workflowRuns, workflowRunSteps, workflows } from '@hfos/db/schema';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { FRESH_MINUTES } from '../mobile';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import { hasWorkspacePermission } from '../permissions';
import {
  LIVE_RUN_STATUSES,
  WorkflowContactInput,
  WorkflowDecideApprovalInput,
  WorkflowDecideApprovalOutput,
  WorkflowEnrolOutput,
  WorkflowRemoveContactOutput,
  WorkflowStepActionInput,
  WorkflowStepActionOutput,
  WorkflowStopRunInput,
  WorkflowStopRunOutput,
} from '../schemas/workflow';
import { loadWorkflow, personNames } from '../workflows/load';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const LIVE: readonly string[] = LIVE_RUN_STATUSES;
const customerName = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`.trim() || 'Customer';
const managesWorkflows = (ctx: CommandContext) =>
  hasWorkspacePermission(ctx.scope.workspaceRole, 'workflows.manage');

async function workflowName(ctx: CommandContext, workflowId: string): Promise<string> {
  const [w] = await ctx.tx
    .select({ name: workflows.name })
    .from(workflows)
    .where(eq(workflows.id, workflowId));
  return w?.name ?? 'A workflow';
}

async function loadRun(ctx: CommandContext, runId: string, forUpdate = false) {
  const query = ctx.tx
    .select({
      id: workflowRuns.id,
      workflowId: workflowRuns.workflowId,
      status: workflowRuns.status,
      personId: workflowRuns.personId,
      isTest: workflowRuns.isTest,
    })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, ctx.scope.workspaceId!)));
  const [run] = forUpdate ? await query.for('update') : await query;
  if (!run) throw HfosError.notFound('Run not found.');
  return run;
}

export const workflowEnrol = defineCommand({
  name: 'workflow.enrol',
  description:
    'Add a customer to a live workflow ("Add to workflow…"). The engine starts the run, keeping to the workflow’s re-entry setting.',
  risk: 2,
  input: WorkflowContactInput,
  output: WorkflowEnrolOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['workflow.enrol_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const { row } = await loadWorkflow(ctx.tx, ws, input.workflowId);
    if (row.status !== 'active' || !row.activeVersionId)
      throw HfosError.conflict(
        row.status === 'paused'
          ? 'This workflow is paused. Resume it to add people.'
          : row.status === 'draft'
            ? 'Publish this workflow first.'
            : 'This workflow is archived.',
        'workflow_not_active',
      );
    const person = await requirePerson(ctx.tx, ws, input.personId);
    await ctx.emit({
      type: 'workflow.enrol_requested',
      entityType: 'workflow',
      entityId: row.id,
      payload: {
        workflowId: row.id,
        versionId: row.activeVersionId,
        personId: person.id,
        requestedBy: me,
      },
      after: { name: row.name, customer: customerName(person) },
    });
    return { workflowId: row.id, personId: person.id, requested: true as const };
  },
});

export const workflowRemoveContact = defineCommand({
  name: 'workflow.remove_contact',
  description:
    'Take a customer out of a workflow: their runs still going stop. Owners and admins stop them at once; for anyone else the engine does.',
  risk: 1,
  input: WorkflowContactInput,
  output: WorkflowRemoveContactOutput,
  permission: 'records.write',
  scope: inWorkspace,
  emits: ['workflow.contact_removed'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const { row } = await loadWorkflow(ctx.tx, ws, input.workflowId);
    const person = await requirePerson(ctx.tx, ws, input.personId);
    const live = (
      await ctx.tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.workflowId, row.id),
            eq(workflowRuns.personId, person.id),
            inArray(workflowRuns.status, [...LIVE_RUN_STATUSES]),
          ),
        )
    ).map((r) => r.id);
    if (!live.length)
      return { workflowId: row.id, personId: person.id, stoppedRunIds: [], pending: false };
    // Row-level security lets only workflows.manage stop runs; anyone else's removal is finished by the engine.
    const pending = !managesWorkflows(ctx);
    const stoppedRunIds = pending
      ? []
      : (
          await ctx.tx
            .update(workflowRuns)
            .set({ status: 'stopped', endReason: 'removed_from_workflow', endedAt: dsql`now()` })
            .where(
              and(
                inArray(workflowRuns.id, live),
                inArray(workflowRuns.status, [...LIVE_RUN_STATUSES]),
              ),
            )
            .returning({ id: workflowRuns.id })
        ).map((r) => r.id);
    await ctx.emit({
      type: 'workflow.contact_removed',
      entityType: 'workflow',
      entityId: row.id,
      payload: {
        workflowId: row.id,
        personId: person.id,
        runIds: live,
        stoppedRunIds,
        pending,
      },
      after: { name: row.name, customer: customerName(person), runs: live.length },
    });
    return { workflowId: row.id, personId: person.id, stoppedRunIds, pending };
  },
});

export const workflowStopRun = defineCommand({
  name: 'workflow.stop_run',
  description: 'Stop one run that is still going. A run that already ended is left as it is.',
  risk: 1,
  input: WorkflowStopRunInput,
  output: WorkflowStopRunOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow_run.stopped'],
  async handler(ctx, input) {
    const run = await loadRun(ctx, input.runId, true);
    if (!LIVE.includes(run.status)) return { runId: run.id, status: run.status, stopped: false };
    const reason = input.reason?.trim() || 'stopped_by_person';
    await ctx.tx
      .update(workflowRuns)
      .set({ status: 'stopped', endReason: reason, endedAt: dsql`now()` })
      .where(eq(workflowRuns.id, run.id));
    const names = run.personId ? await personNames(ctx.tx, [run.personId]) : null;
    await ctx.emit({
      type: 'workflow_run.stopped',
      entityType: 'workflow_run',
      entityId: run.id,
      payload: {
        runId: run.id,
        workflowId: run.workflowId,
        personId: run.personId,
        reason,
        isTest: run.isTest,
      },
      before: { status: run.status },
      after: {
        workflow: await workflowName(ctx, run.workflowId),
        status: 'stopped',
        ...(run.personId ? { customer: names!.get(run.personId) } : {}),
      },
    });
    return { runId: run.id, status: 'stopped' as const, stopped: true };
  },
});

export const workflowDecideApproval = defineCommand({
  name: 'workflow.decide_approval',
  description:
    'Approve (optionally editing what goes out) or reject a workflow’s approval step. The people it names, or owners and admins, decide; it can be decided once.',
  risk: 2,
  input: WorkflowDecideApprovalInput,
  output: WorkflowDecideApprovalOutput,
  // The approver may be a member: who may decide is checked on the approval itself.
  permission: 'workspace.read',
  scope: inWorkspace,
  emits: ['workflow.approval_decided'],
  offline: { freshMinutes: FRESH_MINUTES },
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [a] = await ctx.tx
      .select()
      .from(workflowApprovals)
      .where(
        and(
          eq(workflowApprovals.id, input.approvalId),
          eq(workflowApprovals.workspaceId, ctx.scope.workspaceId!),
        ),
      );
    if (!a) throw HfosError.notFound('Approval not found.');
    if (!managesWorkflows(ctx) && !a.approvers.includes(me))
      throw HfosError.forbidden(
        'Only the people this approval names, or owners and admins, can decide it.',
        'not_an_approver',
      );
    const decided = () => HfosError.conflict('This was already decided.', 'approval_decided');
    if (a.status !== 'pending') throw decided();
    if (a.expiresAt && a.expiresAt.getTime() <= Date.now())
      throw HfosError.conflict('This approval has expired.', 'approval_expired');
    const status = input.decision === 'approve' ? ('approved' as const) : ('rejected' as const);
    const edits =
      input.decision === 'approve' && input.edits && Object.keys(input.edits).length
        ? input.edits
        : null;
    // Claimed once: a second click (or a race) matches no pending row.
    const [claimed] = await ctx.tx
      .update(workflowApprovals)
      .set({
        status,
        edits,
        reason: input.reason ?? null,
        decidedBy: me,
        decidedAt: dsql`now()`,
        via: ctx.meta.channel === 'assistant' ? 'assistant' : 'web',
      })
      .where(and(eq(workflowApprovals.id, a.id), eq(workflowApprovals.status, 'pending')))
      .returning({ id: workflowApprovals.id });
    if (!claimed) throw decided();
    const [run] = await ctx.tx
      .select({ personId: workflowRuns.personId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, a.runId));
    const personId = run?.personId ?? null;
    const names = personId ? await personNames(ctx.tx, [personId]) : null;
    await ctx.emit({
      type: 'workflow.approval_decided',
      entityType: 'workflow_approval',
      entityId: a.id,
      payload: {
        approvalId: a.id,
        runId: a.runId,
        workflowId: a.workflowId,
        stepKey: a.stepKey,
        decision: status,
        edited: edits !== null,
        reason: input.reason ?? null,
      },
      before: { status: 'pending' },
      after: {
        workflow: await workflowName(ctx, a.workflowId),
        decision: status === 'approved' ? 'Approved' : 'Rejected',
        ...(personId ? { customer: names!.get(personId) } : {}),
        ...(edits ? { edited: true } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
    });
    return { approvalId: a.id, runId: a.runId, status };
  },
});

async function stepRequest(
  ctx: CommandContext,
  input: { runId: string; stepKey: string },
  kind: 'retry' | 'skip',
) {
  const me = requireHuman(ctx).userId;
  const run = await loadRun(ctx, input.runId);
  if (run.status === 'completed' || run.status === 'stopped')
    throw HfosError.conflict('This run has ended.', 'run_ended');
  const [step] = await ctx.tx
    .select({ status: workflowRunSteps.status })
    .from(workflowRunSteps)
    .where(and(eq(workflowRunSteps.runId, run.id), eq(workflowRunSteps.stepKey, input.stepKey)));
  if (!step) throw HfosError.notFound('That step hasn’t run.');
  if (step.status !== 'failed' && step.status !== 'dead')
    throw HfosError.conflict('Only a failed step can be retried or skipped.', 'step_not_failed');
  await ctx.emit({
    type: kind === 'retry' ? 'workflow.step_retry_requested' : 'workflow.step_skip_requested',
    entityType: 'workflow_run',
    entityId: run.id,
    payload: {
      runId: run.id,
      workflowId: run.workflowId,
      stepKey: input.stepKey,
      requestedBy: me,
    },
    after: {
      workflow: await workflowName(ctx, run.workflowId),
      step: input.stepKey,
      action: kind === 'retry' ? 'Retry' : 'Skip',
    },
  });
  return { runId: run.id, stepKey: input.stepKey, requested: true as const };
}

export const workflowRetryStep = defineCommand({
  name: 'workflow.retry_step',
  description: 'Ask the engine to run a failed step of a run again.',
  risk: 2,
  input: WorkflowStepActionInput,
  output: WorkflowStepActionOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.step_retry_requested'],
  async handler(ctx, input) {
    return stepRequest(ctx, input, 'retry');
  },
});

export const workflowSkipStep = defineCommand({
  name: 'workflow.skip_step',
  description: 'Ask the engine to skip a failed step of a run and carry on with the next one.',
  risk: 1,
  input: WorkflowStepActionInput,
  output: WorkflowStepActionOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.step_skip_requested'],
  async handler(ctx, input) {
    return stepRequest(ctx, input, 'skip');
  },
});
