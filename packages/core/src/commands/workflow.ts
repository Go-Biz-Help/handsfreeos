/**
 * Workflows: create (blank, a recipe, or an AI builder proposal), save the one draft all three editors
 * change (patch ops against a base revision), publish it as an append-only version, pause, resume, archive,
 * restore an old version, and ask the engine for a test run. People never insert runs, versions' tests or
 * the tested revision: a test is a request event the engine answers.
 */
import { and, desc, eq, inArray, sql as dsql } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { workflowProposals, workflowRuns, workflows, workflowVersions } from '@hfos/db/schema';
import { requirePerson } from '../crm/records';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import type { CommandContext } from '../kernel/types';
import {
  LIVE_RUN_STATUSES,
  WorkflowCreateInput,
  WorkflowCreateOutput,
  WorkflowProposalApplyInput,
  WorkflowProposalApplyOutput,
  WorkflowProposalCreateInput,
  WorkflowProposalCreateOutput,
  WorkflowProposalMarkAppliedInput,
  WorkflowProposalMarkAppliedOutput,
  WorkflowPublishInput,
  WorkflowPublishOutput,
  WorkflowRefInput,
  WorkflowRenameInput,
  WorkflowRenameOutput,
  WorkflowRestoreVersionInput,
  WorkflowSaveDraftInput,
  WorkflowSaveDraftOutput,
  WorkflowStatusOutput,
  WorkflowTestInput,
  WorkflowTestOutput,
} from '../schemas/workflow';
import { blankDefinition, parseDefinition, type WorkflowDefinition } from '../workflows/definition';
import { describeOps, describeTrigger, diffWorkflows } from '../workflows/describe';
import { jsonEqual } from '../workflows/json';
import {
  loadWorkflow,
  parseStoredDefinition,
  triggerIndex,
  workflowIssues,
  type WorkflowRow,
} from '../workflows/load';
import { applyWorkflowOps, WorkflowOpError, type WorkflowOp } from '../workflows/ops';
import {
  placeholdersIn,
  recipeByKey,
  recipeDefinition,
  resolvePlaceholders,
} from '../workflows/recipes';
import { hasBlockingWorkflowIssues, type WorkflowIssue } from '../workflows/rules';

const inWorkspace = (i: { workspaceId: string }) => ({
  kind: 'workspace' as const,
  workspaceId: i.workspaceId,
});
const asJson = (d: WorkflowDefinition) => d as unknown as Record<string, unknown>;
/** Audit entries keep the first lines of a long batch. */
const MAX_CHANGE_LINES = 40;
const capLines = (lines: string[]) =>
  lines.length <= MAX_CHANGE_LINES
    ? lines
    : [...lines.slice(0, MAX_CHANGE_LINES - 1), `…and ${lines.length - MAX_CHANGE_LINES + 1} more`];

// ---- Shared pieces ----

export function workflowRevisionConflict(revision: number): HfosError {
  return new HfosError(
    'conflict',
    409,
    'Someone saved this workflow in the meantime. Reload to see their changes.',
    { revision },
    'revision_conflict',
  );
}

function workflowIssuesError(issues: readonly WorkflowIssue[], message: string): HfosError {
  return new HfosError('rule_violation', 422, message, { issues }, 'workflow_issues');
}

/** Applies ops all or nothing; a bad op is a 400 naming its index and what's wrong. */
function applyOps(def: WorkflowDefinition, ops: readonly unknown[]): WorkflowDefinition {
  try {
    return applyWorkflowOps(def, ops as readonly WorkflowOp[]).definition;
  } catch (e) {
    if (!(e instanceof WorkflowOpError)) throw e;
    throw new HfosError(
      'validation',
      400,
      e.message,
      { opIndex: e.opIndex, code: e.code, stepId: e.stepId, issues: e.issues },
      'workflow_op_invalid',
    );
  }
}

function assertNotArchived(row: WorkflowRow): void {
  if (row.status === 'archived')
    throw HfosError.conflict('This workflow is archived.', 'workflow_archived');
}

interface SaveArgs {
  readonly workflowId: string;
  readonly baseRevision: number;
  readonly ops: readonly unknown[];
  readonly restoredFrom?: number;
  readonly proposalId?: string;
}

/**
 * The save path (save, restore, applying a proposal): the ops against the base revision, a new revision
 * when anything changed, and the trigger index while nothing is published yet.
 */
async function saveDraft(ctx: CommandContext, args: SaveArgs) {
  const ws = ctx.scope.workspaceId!;
  const current = await loadWorkflow(ctx.tx, ws, args.workflowId, { forUpdate: true });
  assertNotArchived(current.row);
  if (current.row.revision !== args.baseRevision)
    throw workflowRevisionConflict(current.row.revision);
  const next = applyOps(current.definition, args.ops);
  const { issues, catalogs } = await workflowIssues(ctx.tx, ws, next);
  if (jsonEqual(next, current.definition))
    return {
      workflowId: current.row.id,
      revision: current.row.revision,
      changed: false,
      changes: [],
      issues,
    };
  const changes = [
    ...(args.restoredFrom ? [`Restored version ${args.restoredFrom}`] : []),
    ...describeOps(args.ops as readonly WorkflowOp[], current.definition, catalogs),
  ];
  const revision = current.row.revision + 1;
  await ctx.tx
    .update(workflows)
    .set({
      definition: asJson(next),
      definitionVersion: next.version,
      revision,
      // Once a version is published, the dispatcher follows what runs, not the draft.
      ...(current.row.activeVersionId ? {} : triggerIndex(next)),
    })
    .where(eq(workflows.id, current.row.id));
  await ctx.emit({
    type: 'workflow.draft_saved',
    entityType: 'workflow',
    entityId: current.row.id,
    payload: {
      revision,
      changes: capLines(changes),
      opCount: args.ops.length,
      ...(args.restoredFrom ? { restoredFrom: args.restoredFrom } : {}),
      ...(args.proposalId ? { proposalId: args.proposalId } : {}),
    },
    before: { name: current.row.name, revision: current.row.revision },
    after: { name: current.row.name, revision, changes: capLines(changes) },
  });
  return { workflowId: current.row.id, revision, changed: true, changes, issues };
}

type ProposalRow = typeof workflowProposals.$inferSelect;

/** A proposal that can still be applied: not yet applied, not expired. Locked. */
async function openProposal(ctx: CommandContext, proposalId: string): Promise<ProposalRow> {
  const [row] = await ctx.tx
    .select()
    .from(workflowProposals)
    .where(
      and(
        eq(workflowProposals.id, proposalId),
        eq(workflowProposals.workspaceId, ctx.scope.workspaceId!),
      ),
    )
    .for('update');
  if (!row) throw HfosError.notFound('Proposal not found.');
  if (row.appliedAt)
    throw HfosError.conflict('This proposal was already applied.', 'proposal_applied');
  if (row.expiresAt.getTime() < Date.now())
    throw HfosError.conflict('This proposal has expired. Ask again.', 'proposal_expired');
  return row;
}

async function markApplied(ctx: CommandContext, proposal: ProposalRow): Promise<void> {
  await ctx.tx
    .update(workflowProposals)
    .set({ appliedAt: dsql`now()` })
    .where(eq(workflowProposals.id, proposal.id));
  await ctx.emit({
    type: 'workflow_proposal.applied',
    entityType: 'workflow_proposal',
    entityId: proposal.id,
    payload: { workflowId: proposal.workflowId, opCount: proposal.ops.length },
    after: { summary: proposal.summary ?? proposal.prompt.slice(0, 200) },
  });
}

interface CreateArgs {
  readonly name: string;
  readonly description: string | null;
  readonly definition: WorkflowDefinition;
  readonly from: 'blank' | 'recipe' | 'proposal';
  readonly sourceLabel: string;
  readonly recipeKey?: string;
  readonly proposalId?: string;
}

async function insertWorkflow(ctx: CommandContext, args: CreateArgs) {
  const me = requireHuman(ctx).userId;
  const ws = ctx.scope.workspaceId!;
  const def = args.definition;
  const [row] = await ctx.tx
    .insert(workflows)
    .values({
      workspaceId: ws,
      name: args.name,
      description: args.description,
      status: 'draft',
      definition: asJson(def),
      definitionVersion: def.version,
      revision: 1,
      ...triggerIndex(def),
      createdBy: me,
    })
    .returning({ id: workflows.id });
  if (!row) throw HfosError.forbidden();
  const { issues, catalogs } = await workflowIssues(ctx.tx, ws, def);
  await ctx.emit({
    type: 'workflow.created',
    entityType: 'workflow',
    entityId: row.id,
    payload: {
      name: args.name,
      from: args.from,
      ...(args.recipeKey ? { recipeKey: args.recipeKey } : {}),
      ...(args.proposalId ? { proposalId: args.proposalId } : {}),
      triggerKind: def.trigger.kind,
    },
    after: {
      name: args.name,
      status: 'draft',
      source: args.sourceLabel,
      trigger: describeTrigger(def.trigger, catalogs),
    },
  });
  return { workflowId: row.id, revision: 1, issues, placeholders: placeholdersIn(def) };
}

/** Turns a proposal for a new workflow into one. */
async function createFromProposal(ctx: CommandContext, proposal: ProposalRow, name: string) {
  if (proposal.workflowId)
    throw HfosError.conflict(
      'This proposal changes an existing workflow. Open that workflow to apply it.',
      'proposal_for_existing',
    );
  const definition = applyOps(blankDefinition(), proposal.ops);
  const out = await insertWorkflow(ctx, {
    name,
    description: null,
    definition,
    from: 'proposal',
    sourceLabel: 'Described to the AI builder',
    proposalId: proposal.id,
  });
  await markApplied(ctx, proposal);
  return out;
}

const nameFromProposal = (p: ProposalRow) =>
  (p.summary ?? p.prompt).replace(/\s+/g, ' ').trim().slice(0, 60).trim() || 'New workflow';

// ---- Commands ----

export const workflowCreate = defineCommand({
  name: 'workflow.create',
  description:
    'Create a workflow as an untested draft: blank (with a trigger), from a built-in recipe (with placeholders mapped to this business), or from an AI builder proposal.',
  risk: 1,
  input: WorkflowCreateInput,
  output: WorkflowCreateOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.created', 'workflow_proposal.applied'],
  async handler(ctx, input) {
    const description = input.description ?? null;
    if (input.from === 'proposal') {
      const proposal = await openProposal(ctx, input.proposalId!);
      return createFromProposal(ctx, proposal, input.name);
    }
    if (input.from === 'recipe') {
      const recipe = recipeByKey(input.recipeKey!)!;
      const raw = recipeDefinition(recipe.key);
      const known = new Set(placeholdersIn(raw).map((p) => p.key));
      const mapping = input.mapping ?? {};
      const strangers = Object.keys(mapping).filter((k) => !known.has(k));
      if (strangers.length)
        throw HfosError.validation(
          strangers.map((k) => ({
            path: `mapping.${k}`,
            message: 'That isn’t one of the recipe’s placeholders.',
          })),
        );
      return insertWorkflow(ctx, {
        name: input.name,
        description,
        definition: parseDefinition(resolvePlaceholders(raw, mapping)),
        from: 'recipe',
        sourceLabel: `${recipe.name} recipe`,
        recipeKey: recipe.key,
      });
    }
    return insertWorkflow(ctx, {
      name: input.name,
      description,
      definition: blankDefinition(input.trigger ?? { kind: 'manual' }),
      from: 'blank',
      sourceLabel: 'Blank',
    });
  },
});

export const workflowSaveDraft = defineCommand({
  name: 'workflow.save_draft',
  description:
    'Save edits to a workflow’s draft as patch ops made against a base revision. A stale base is a 409 revision_conflict; a bad op is a 400 naming its index. Drafts never run.',
  risk: 1,
  input: WorkflowSaveDraftInput,
  output: WorkflowSaveDraftOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.draft_saved'],
  async handler(ctx, input) {
    return saveDraft(ctx, input);
  },
});

export const workflowRename = defineCommand({
  name: 'workflow.rename',
  description: 'Rename a workflow or change its description.',
  risk: 1,
  input: WorkflowRenameInput,
  output: WorkflowRenameOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.renamed'],
  async handler(ctx, input) {
    const { row } = await loadWorkflow(ctx.tx, ctx.scope.workspaceId!, input.workflowId, {
      forUpdate: true,
    });
    const patch: { name?: string; description?: string | null } = {};
    if (input.name !== undefined && input.name !== row.name) patch.name = input.name;
    if (input.description !== undefined && (input.description ?? null) !== row.description)
      patch.description = input.description ?? null;
    const name = patch.name ?? row.name;
    const description = patch.description !== undefined ? patch.description : row.description;
    if (!Object.keys(patch).length) return { workflowId: row.id, name, description };
    await ctx.tx.update(workflows).set(patch).where(eq(workflows.id, row.id));
    await ctx.emit({
      type: 'workflow.renamed',
      entityType: 'workflow',
      entityId: row.id,
      payload: { fields: Object.keys(patch) },
      before: {
        name: row.name,
        ...(patch.description !== undefined ? { description: row.description } : {}),
      },
      after: { name, ...(patch.description !== undefined ? { description } : {}) },
    });
    return { workflowId: row.id, name, description };
  },
});

export const workflowPublish = defineCommand({
  name: 'workflow.publish',
  description:
    'Publish the draft as a new, unchangeable version that new runs start on. Needs no blocking issues (422) and a passing test of this exact draft revision (409 not_tested).',
  risk: 2,
  input: WorkflowPublishInput,
  output: WorkflowPublishOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.published'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const { row, definition: draft } = await loadWorkflow(ctx.tx, ws, input.workflowId, {
      forUpdate: true,
    });
    assertNotArchived(row);
    if (row.revision !== input.baseRevision) throw workflowRevisionConflict(row.revision);
    const { issues, catalogs } = await workflowIssues(ctx.tx, ws, draft);
    if (hasBlockingWorkflowIssues(issues))
      throw workflowIssuesError(issues, 'Fix the problems in this workflow before publishing it.');
    if (row.testedRevision !== row.revision)
      throw HfosError.conflict(
        'Run a test first. Publishing needs a passing test of the draft as it is now.',
        'not_tested',
      );
    const [prev] = await ctx.tx
      .select({
        id: workflowVersions.id,
        version: workflowVersions.version,
        definition: workflowVersions.definition,
      })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, row.id))
      .orderBy(desc(workflowVersions.version))
      .limit(1);
    const prevDef = prev ? parseStoredDefinition(prev.definition) : null;
    // Publishing what already runs changes nothing.
    if (prev && prevDef && row.activeVersionId === prev.id && jsonEqual(prevDef, draft))
      return {
        workflowId: row.id,
        versionId: prev.id,
        version: prev.version,
        status: row.status,
        changes: [],
      };
    const changes = prevDef
      ? describeOps(diffWorkflows(prevDef, draft), prevDef, catalogs)
      : ['First version'];
    const [test] = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.workflow_runs
          where workflow_id = ${row.id} and is_test and test_revision = ${row.revision} and status = 'completed'
          order by ended_at desc nulls last limit 1`,
    );
    const version = (prev?.version ?? 0) + 1;
    const source =
      ctx.meta.channel === 'assistant'
        ? 'assistant'
        : row.templateId && row.installedRevision === row.revision
          ? 'template'
          : 'editor';
    const [created] = await ctx.tx
      .insert(workflowVersions)
      .values({
        workspaceId: ws,
        workflowId: row.id,
        version,
        definition: asJson(draft),
        definitionVersion: draft.version,
        revision: row.revision,
        testRunId: test?.id ?? null,
        source,
        diffSummary: capLines(changes) as unknown as Record<string, unknown>[],
        publishedBy: me,
      })
      .returning({ id: workflowVersions.id });
    if (!created) throw HfosError.forbidden();
    // A paused workflow stays paused: Resume is what releases its held runs.
    const status = row.status === 'paused' ? ('paused' as const) : ('active' as const);
    await ctx.tx
      .update(workflows)
      .set({ activeVersionId: created.id, status, ...triggerIndex(draft) })
      .where(eq(workflows.id, row.id));
    await ctx.emit({
      type: 'workflow.published',
      entityType: 'workflow',
      entityId: row.id,
      payload: {
        versionId: created.id,
        version,
        revision: row.revision,
        previousVersionId: row.activeVersionId,
        status,
        testRunId: test?.id ?? null,
      },
      before: { name: row.name, status: row.status, version: prev?.version ?? null },
      after: { name: row.name, status, version, changes: capLines(changes) },
    });
    return { workflowId: row.id, versionId: created.id, version, status, changes };
  },
});

type StatusChange = 'pause' | 'resume' | 'archive';

async function changeStatus(ctx: CommandContext, workflowId: string, change: StatusChange) {
  const ws = ctx.scope.workspaceId!;
  const { row } = await loadWorkflow(ctx.tx, ws, workflowId, { forUpdate: true });
  const to =
    change === 'pause'
      ? ('paused' as const)
      : change === 'resume'
        ? ('active' as const)
        : ('archived' as const);
  const same = { workflowId: row.id, status: row.status, changed: false, stoppedRunIds: [] };
  if (row.status === to) return same;
  if (change === 'pause' && row.status !== 'active')
    throw HfosError.conflict(
      row.status === 'draft' ? 'Publish this workflow first.' : 'This workflow is archived.',
      'workflow_not_active',
    );
  if (change === 'resume' && row.status !== 'paused')
    throw HfosError.conflict(
      row.status === 'draft' ? 'Publish this workflow first.' : 'This workflow is archived.',
      'workflow_not_paused',
    );
  await ctx.tx.update(workflows).set({ status: to }).where(eq(workflows.id, row.id));
  // Archiving stops the runs still going; the engine cancels their approvals and jobs.
  const stoppedRunIds =
    change === 'archive'
      ? (
          await ctx.tx
            .update(workflowRuns)
            .set({ status: 'stopped', endReason: 'workflow_archived', endedAt: dsql`now()` })
            .where(
              and(
                eq(workflowRuns.workflowId, row.id),
                inArray(workflowRuns.status, [...LIVE_RUN_STATUSES]),
              ),
            )
            .returning({ id: workflowRuns.id })
        ).map((r) => r.id)
      : [];
  await ctx.emit({
    type: `workflow.${change === 'pause' ? 'paused' : change === 'resume' ? 'resumed' : 'archived'}`,
    entityType: 'workflow',
    entityId: row.id,
    payload: {
      from: row.status,
      to,
      activeVersionId: row.activeVersionId,
      ...(change === 'archive' ? { stoppedRunIds } : {}),
    },
    before: { name: row.name, status: row.status },
    after: {
      name: row.name,
      status: to,
      ...(stoppedRunIds.length ? { stoppedRuns: stoppedRunIds.length } : {}),
    },
  });
  return { workflowId: row.id, status: to, changed: true, stoppedRunIds };
}

export const workflowPause = defineCommand({
  name: 'workflow.pause',
  description:
    'Pause a live workflow: nothing new starts (triggers are ignored, not queued) and runs hold at their next step.',
  risk: 1,
  input: WorkflowRefInput,
  output: WorkflowStatusOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.paused'],
  async handler(ctx, input) {
    return changeStatus(ctx, input.workflowId, 'pause');
  },
});

export const workflowResume = defineCommand({
  name: 'workflow.resume',
  description:
    'Resume a paused workflow. New triggers start runs again and held runs are released in batches.',
  risk: 2,
  input: WorkflowRefInput,
  output: WorkflowStatusOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.resumed'],
  async handler(ctx, input) {
    return changeStatus(ctx, input.workflowId, 'resume');
  },
});

export const workflowArchive = defineCommand({
  name: 'workflow.archive',
  description:
    'Archive a workflow. It stops its runs still going; its versions, runs and history stay.',
  risk: 2,
  input: WorkflowRefInput,
  output: WorkflowStatusOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.archived'],
  async handler(ctx, input) {
    return changeStatus(ctx, input.workflowId, 'archive');
  },
});

export const workflowRestoreVersion = defineCommand({
  name: 'workflow.restore_version',
  description:
    'Copy a published version back into the draft as a new revision. It needs a new test before it can be published.',
  risk: 1,
  input: WorkflowRestoreVersionInput,
  output: WorkflowSaveDraftOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.draft_saved'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    const [ver] = await ctx.tx
      .select({ definition: workflowVersions.definition })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.workflowId, input.workflowId),
          eq(workflowVersions.workspaceId, ws),
          eq(workflowVersions.version, input.version),
        ),
      );
    if (!ver) throw HfosError.notFound('Version not found.');
    // Same revision means same draft, so ops diffed from this read apply to the locked row in saveDraft.
    const current = await loadWorkflow(ctx.tx, ws, input.workflowId);
    if (current.row.revision !== input.baseRevision)
      throw workflowRevisionConflict(current.row.revision);
    return saveDraft(ctx, {
      workflowId: input.workflowId,
      baseRevision: input.baseRevision,
      ops: diffWorkflows(current.definition, parseStoredDefinition(ver.definition)),
      restoredFrom: input.version,
    });
  },
});

export const workflowTest = defineCommand({
  name: 'workflow.test',
  description:
    'Ask for a test run of the draft as it is now: Simulate (sends nothing, fast-forwards waits) or Send to me (sends only to you). A pass lets that revision be published.',
  risk: 1,
  input: WorkflowTestInput,
  output: WorkflowTestOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.test_requested'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const ws = ctx.scope.workspaceId!;
    const { row, definition } = await loadWorkflow(ctx.tx, ws, input.workflowId);
    assertNotArchived(row);
    const person = input.personId ? await requirePerson(ctx.tx, ws, input.personId) : null;
    const { issues } = await workflowIssues(ctx.tx, ws, definition);
    if (hasBlockingWorkflowIssues(issues))
      throw workflowIssuesError(issues, 'Fix the problems in this workflow before testing it.');
    const eventId = await ctx.emit({
      type: 'workflow.test_requested',
      entityType: 'workflow',
      entityId: row.id,
      payload: {
        workflowId: row.id,
        revision: row.revision,
        mode: input.mode,
        personId: person?.id ?? null,
        assume: input.assume ?? {},
        requestedBy: me,
      },
      after: {
        name: row.name,
        revision: row.revision,
        mode: input.mode === 'simulate' ? 'Simulate' : 'Send to me',
        ...(person ? { customer: `${person.firstName} ${person.lastName}`.trim() } : {}),
      },
    });
    return {
      workflowId: row.id,
      revision: row.revision,
      mode: input.mode,
      requested: true as const,
      eventId,
    };
  },
});

export const workflowProposalCreate = defineCommand({
  name: 'workflow_proposal.create',
  description:
    'System (the AI builder): store a proposal until someone applies it or it expires. Its ops must apply to the draft revision it names, or to a blank workflow for a new one.',
  risk: 1,
  input: WorkflowProposalCreateInput,
  output: WorkflowProposalCreateOutput,
  permission: null,
  scope: inWorkspace,
  actors: ['system'],
  emits: ['workflow_proposal.created'],
  async handler(ctx, input) {
    const ws = ctx.scope.workspaceId!;
    let base = blankDefinition();
    let name: string | null = null;
    if (input.workflowId) {
      const current = await loadWorkflow(ctx.tx, ws, input.workflowId);
      assertNotArchived(current.row);
      if (current.row.revision !== input.baseRevision)
        throw HfosError.conflict(
          'The workflow changed since this was drafted. Ask again.',
          'proposal_stale',
        );
      base = current.definition;
      name = current.row.name;
    }
    // Nothing is stored that can't be applied as it stands.
    applyOps(base, input.ops);
    const [row] = await ctx.tx
      .insert(workflowProposals)
      .values({
        workspaceId: ws,
        workflowId: input.workflowId,
        baseRevision: input.baseRevision,
        prompt: input.prompt,
        ops: input.ops as unknown as (typeof workflowProposals.$inferInsert)['ops'],
        summary: input.summary,
        unsupported: input.unsupported,
        createdBy: input.createdBy,
      })
      .returning({ id: workflowProposals.id, expiresAt: workflowProposals.expiresAt });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'workflow_proposal.created',
      entityType: 'workflow_proposal',
      entityId: row.id,
      payload: {
        proposalId: row.id,
        workflowId: input.workflowId,
        baseRevision: input.baseRevision,
        opCount: input.ops.length,
        unsupported: input.unsupported.length,
      },
      after: {
        ...(name ? { name } : {}),
        summary: input.summary ?? input.prompt.slice(0, 200),
      },
    });
    return { proposalId: row.id, expiresAt: row.expiresAt.toISOString() };
  },
});

export const workflowProposalApply = defineCommand({
  name: 'workflow_proposal.apply',
  description:
    'Apply an AI builder proposal: its ops go into the workflow’s draft as one edit (refused when the draft moved on since), or a new workflow is created when the proposal is for one.',
  risk: 1,
  input: WorkflowProposalApplyInput,
  output: WorkflowProposalApplyOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow.created', 'workflow.draft_saved', 'workflow_proposal.applied'],
  async handler(ctx, input) {
    const proposal = await openProposal(ctx, input.proposalId);
    if (!proposal.workflowId) {
      const out = await createFromProposal(ctx, proposal, input.name ?? nameFromProposal(proposal));
      return {
        workflowId: out.workflowId,
        revision: out.revision,
        created: true,
        changes: describeOps(proposal.ops as unknown as WorkflowOp[], blankDefinition()),
        issues: out.issues,
      };
    }
    if (input.baseRevision === undefined)
      throw HfosError.validation([
        { path: 'baseRevision', message: 'Say which revision of the draft you have.' },
      ]);
    if (proposal.baseRevision !== input.baseRevision)
      throw HfosError.conflict(
        'The workflow changed since this was proposed. Ask again.',
        'proposal_stale',
      );
    const out = await saveDraft(ctx, {
      workflowId: proposal.workflowId,
      baseRevision: input.baseRevision,
      ops: proposal.ops,
      proposalId: proposal.id,
    });
    await markApplied(ctx, proposal);
    return {
      workflowId: out.workflowId,
      revision: out.revision,
      created: false,
      changes: out.changes,
      issues: out.issues,
    };
  },
});

export const workflowProposalMarkApplied = defineCommand({
  name: 'workflow_proposal.mark_applied',
  description:
    'Record that the editor applied an AI builder proposal to a workflow’s draft and saved it (the editor applies the ops itself, as one Undo), so the Assistant no longer offers it. Refused until the draft is saved past the revision it was drafted against.',
  risk: 1,
  input: WorkflowProposalMarkAppliedInput,
  output: WorkflowProposalMarkAppliedOutput,
  permission: 'workflows.manage',
  scope: inWorkspace,
  emits: ['workflow_proposal.applied'],
  async handler(ctx, input) {
    requireHuman(ctx);
    const ws = ctx.scope.workspaceId!;
    const [proposal] = await ctx.tx
      .select()
      .from(workflowProposals)
      .where(and(eq(workflowProposals.id, input.proposalId), eq(workflowProposals.workspaceId, ws)))
      .for('update');
    if (!proposal) throw HfosError.notFound('Proposal not found.');
    if (proposal.appliedAt)
      return {
        proposalId: proposal.id,
        appliedAt: proposal.appliedAt.toISOString(),
        changed: false,
      };
    if (!proposal.workflowId || proposal.baseRevision === null)
      throw HfosError.conflict(
        'This proposal is for a new workflow. Apply it to create the workflow.',
        'proposal_for_new',
      );
    const { row } = await loadWorkflow(ctx.tx, ws, proposal.workflowId);
    if (row.revision <= proposal.baseRevision)
      throw HfosError.conflict('Save the change to the draft first.', 'proposal_not_saved');
    const [marked] = await ctx.tx
      .update(workflowProposals)
      .set({ appliedAt: dsql`now()` })
      .where(eq(workflowProposals.id, proposal.id))
      .returning({ appliedAt: workflowProposals.appliedAt });
    await ctx.emit({
      type: 'workflow_proposal.applied',
      entityType: 'workflow_proposal',
      entityId: proposal.id,
      payload: {
        workflowId: proposal.workflowId,
        opCount: proposal.ops.length,
        revision: row.revision,
      },
      after: { name: row.name, summary: proposal.summary ?? proposal.prompt.slice(0, 200) },
    });
    return { proposalId: proposal.id, appliedAt: marked!.appliedAt!.toISOString(), changed: true };
  },
});
