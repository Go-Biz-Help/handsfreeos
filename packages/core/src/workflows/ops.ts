/**
 * Patch ops: the only way anything changes a workflow. The step list, the canvas and the AI builder all
 * produce these, so nothing is lost switching between them. `applyWorkflowOps` applies a batch all or
 * nothing: it resolves every op, then parses the result with zod and checks the structure (unique ids, a
 * go-to only as the last step of a branch or rejected path). It returns the inverse ops for Undo.
 */
import { z } from 'zod';
import {
  WorkflowDefinition,
  type BranchInput,
  type StepInput,
  type TriggerInput,
  type WorkflowSettingsInput,
} from './definition';
import { BranchId, StepId } from './ids';
import { cloneJson, isPlainObject, mergeJson } from './json';
import { allLanes, allSteps, findStep, laneSteps, moveProblem, type LaneRef } from './walk';

/** A merge patch for a step: objects merge, arrays and null replace. `branches` merges by id (see below). */
export type StepPatch = Readonly<Record<string, unknown>>;

export type WorkflowOp =
  | {
      readonly op: 'add_step';
      readonly parentId: string | null;
      readonly branchId: string | null;
      /** null appends. */
      readonly index: number | null;
      readonly step: StepInput;
    }
  | { readonly op: 'update_step'; readonly stepId: string; readonly patch: StepPatch }
  | {
      readonly op: 'move_step';
      readonly stepId: string;
      readonly parentId: string | null;
      readonly branchId: string | null;
      /** The position in the target list once the step has been taken out. */
      readonly index: number;
    }
  | { readonly op: 'delete_step'; readonly stepId: string }
  | {
      readonly op: 'add_branch';
      readonly stepId: string;
      readonly index: number | null;
      readonly branch: BranchInput;
    }
  | { readonly op: 'delete_branch'; readonly stepId: string; readonly branchId: string }
  | {
      readonly op: 'set_goto';
      readonly stepId: string;
      readonly target: string;
      /** null keeps the current cap. */
      readonly maxVisits: number | null;
    }
  | { readonly op: 'set_trigger'; readonly trigger: TriggerInput }
  | { readonly op: 'set_settings'; readonly patch: Partial<WorkflowSettingsInput> };
export type WorkflowOpName = WorkflowOp['op'];

const laneFields = {
  parentId: StepId.nullable(),
  branchId: z.string().max(20).nullable(),
};
const loose = z.record(z.string(), z.unknown());

/** The shape of ops arriving over the wire; their contents are checked when they're applied. */
export const WorkflowOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_step'),
    ...laneFields,
    index: z.int().min(0).nullable(),
    step: loose,
  }),
  z.object({ op: z.literal('update_step'), stepId: StepId, patch: loose }),
  z.object({ op: z.literal('move_step'), stepId: StepId, ...laneFields, index: z.int().min(0) }),
  z.object({ op: z.literal('delete_step'), stepId: StepId }),
  z.object({
    op: z.literal('add_branch'),
    stepId: StepId,
    index: z.int().min(0).nullable(),
    branch: loose,
  }),
  z.object({ op: z.literal('delete_branch'), stepId: StepId, branchId: BranchId }),
  z.object({
    op: z.literal('set_goto'),
    stepId: StepId,
    target: StepId,
    maxVisits: z.int().min(1).max(10).nullable(),
  }),
  z.object({ op: z.literal('set_trigger'), trigger: loose }),
  z.object({ op: z.literal('set_settings'), patch: loose }),
]);
export const WorkflowOpList = z.array(WorkflowOpSchema).max(500);

export const WORKFLOW_OP_ERROR_CODES = [
  'step_not_found',
  'branch_not_found',
  'lane_not_found',
  'index_out_of_range',
  'move_into_self',
  'not_a_goto',
  'not_a_branch_step',
  'bad_patch',
  'duplicate_id',
  'goto_not_last',
  'invalid',
] as const;
export type WorkflowOpErrorCode = (typeof WORKFLOW_OP_ERROR_CODES)[number];

export interface WorkflowOpIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

export class WorkflowOpError extends Error {
  constructor(
    /** The op that failed (or, for a problem found once the batch is applied, the last op that touched it). */
    readonly opIndex: number,
    readonly code: WorkflowOpErrorCode,
    message: string,
    readonly stepId: string | null = null,
    readonly issues: readonly WorkflowOpIssue[] = [],
  ) {
    super(message);
    this.name = 'WorkflowOpError';
  }
}

export interface ApplyResult {
  readonly definition: WorkflowDefinition;
  /** Applying these to `definition` gives back the original (Undo). */
  readonly inverse: WorkflowOp[];
}

type Work = WorkflowDefinition;
type AnyStep = Record<string, unknown> & { id: string; type: string };

/** Makes sure a pasted step's lists exist, so later ops in the same batch can reach into them. */
function ensureLanes(step: AnyStep): AnyStep {
  if (step.type === 'branch' && Array.isArray(step.branches))
    for (const b of step.branches as Record<string, unknown>[]) {
      if (!Array.isArray(b.steps)) b.steps = [];
      (b.steps as AnyStep[]).forEach(ensureLanes);
    }
  if (step.type === 'approval') {
    if (!isPlainObject(step.rejected)) step.rejected = { steps: [] };
    const lane = step.rejected as Record<string, unknown>;
    if (!Array.isArray(lane.steps)) lane.steps = [];
    (lane.steps as AnyStep[]).forEach(ensureLanes);
  }
  return step;
}

const branchMeta = (b: Record<string, unknown>) => ({
  id: b.id,
  name: b.name,
  condition: b.condition ?? null,
  description: b.description ?? null,
});

function fail(
  i: number,
  code: WorkflowOpErrorCode,
  message: string,
  stepId: string | null = null,
): never {
  throw new WorkflowOpError(i, code, message, stepId);
}

function lane(work: Work, ref: LaneRef, i: number): AnyStep[] {
  const steps = laneSteps(work, ref);
  if (!steps) fail(i, 'lane_not_found', 'That place in the workflow doesn’t exist.', ref.parentId);
  return steps as unknown as AnyStep[];
}

function located(work: Work, stepId: string, i: number) {
  const loc = findStep(work, stepId);
  if (!loc) fail(i, 'step_not_found', 'That step isn’t in the workflow.', stepId);
  return { ...loc, step: loc.step as unknown as AnyStep };
}

function updateStep(
  work: Work,
  op: Extract<WorkflowOp, { op: 'update_step' }>,
  i: number,
): WorkflowOp {
  const { step } = located(work, op.stepId, i);
  const patch = op.patch as Record<string, unknown>;
  if (!isPlainObject(patch)) fail(i, 'bad_patch', 'A change must be an object.', op.stepId);
  const old: Record<string, unknown> = {};
  // A different action replaces the config (its fields are the new action's).
  const changesAction = patch.action !== undefined && patch.action !== step.action;
  if (changesAction) {
    if (step.type !== 'action')
      fail(i, 'bad_patch', 'Only an action step has an action.', op.stepId);
    old.action = step.action;
    old.config = cloneJson(step.config);
    step.action = patch.action;
    step.config = cloneJson(isPlainObject(patch.config) ? patch.config : {});
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (changesAction && (key === 'action' || key === 'config')) continue;
    if ((key === 'id' || key === 'type') && value !== step[key])
      fail(i, 'bad_patch', `A step’s ${key} can’t change.`, op.stepId);
    if (key === 'rejected')
      fail(i, 'bad_patch', 'Change the rejected path with step ops.', op.stepId);
    if (key === 'branches') {
      if (step.type !== 'branch' || !Array.isArray(value))
        fail(i, 'bad_patch', 'Only a branch step has paths.', op.stepId);
      const branches = step.branches as Record<string, unknown>[];
      old.branches = branches.map(branchMeta);
      const edits = value as Record<string, unknown>[];
      for (const edit of edits) {
        const b = isPlainObject(edit) ? branches.find((x) => x.id === edit.id) : undefined;
        if (!b) fail(i, 'branch_not_found', 'That path isn’t on this step.', op.stepId);
        if ('steps' in edit)
          fail(i, 'bad_patch', 'Change a path’s steps with step ops.', op.stepId);
        for (const k of ['name', 'condition', 'description'] as const)
          if (edit[k] !== undefined) b[k] = cloneJson(edit[k]);
      }
      const ids = edits.map((e) => e.id);
      if (ids.length === branches.length && new Set(ids).size === ids.length)
        step.branches = ids.map((id) => branches.find((b) => b.id === id)!);
      continue;
    }
    old[key] = cloneJson(step[key]);
    step[key] = mergeJson(step[key], value);
  }
  return { op: 'update_step', stepId: op.stepId, patch: old };
}

/** Applies one op to the working copy and returns its inverse. */
function applyOne(work: Work, op: WorkflowOp, i: number): WorkflowOp {
  switch (op.op) {
    case 'add_step': {
      if (!isPlainObject(op.step) || typeof op.step.id !== 'string')
        fail(i, 'invalid', 'A new step needs an id.');
      const steps = lane(work, op, i);
      const index = op.index ?? steps.length;
      if (!Number.isInteger(index) || index < 0 || index > steps.length)
        fail(i, 'index_out_of_range', 'That position is outside the list.', op.step.id);
      steps.splice(index, 0, ensureLanes(cloneJson(op.step) as unknown as AnyStep));
      return { op: 'delete_step', stepId: op.step.id };
    }
    case 'delete_step': {
      const loc = located(work, op.stepId, i);
      lane(work, loc.lane, i).splice(loc.index, 1);
      return {
        op: 'add_step',
        parentId: loc.lane.parentId,
        branchId: loc.lane.branchId,
        index: loc.index,
        step: loc.step as unknown as StepInput,
      };
    }
    case 'move_step': {
      const loc = located(work, op.stepId, i);
      const problem = moveProblem(work, op.stepId, op);
      if (problem && problem !== 'goto_not_last')
        fail(i, problem, 'The step can’t go there.', op.stepId);
      lane(work, loc.lane, i).splice(loc.index, 1);
      lane(work, op, i).splice(op.index, 0, loc.step);
      return {
        op: 'move_step',
        stepId: op.stepId,
        parentId: loc.lane.parentId,
        branchId: loc.lane.branchId,
        index: loc.index,
      };
    }
    case 'update_step':
      return updateStep(work, op, i);
    case 'add_branch': {
      const { step } = located(work, op.stepId, i);
      if (step.type !== 'branch')
        fail(i, 'not_a_branch_step', 'Paths go on a branch step.', op.stepId);
      if (!isPlainObject(op.branch))
        fail(i, 'invalid', 'A path needs an id and a name.', op.stepId);
      const branches = step.branches as Record<string, unknown>[];
      const index = op.index ?? branches.length;
      if (!Number.isInteger(index) || index < 0 || index > branches.length)
        fail(i, 'index_out_of_range', 'That position is outside the paths.', op.stepId);
      const branch = cloneJson(op.branch) as unknown as Record<string, unknown>;
      if (!Array.isArray(branch.steps)) branch.steps = [];
      (branch.steps as AnyStep[]).forEach(ensureLanes);
      branches.splice(index, 0, branch);
      return { op: 'delete_branch', stepId: op.stepId, branchId: String(op.branch.id) };
    }
    case 'delete_branch': {
      const { step } = located(work, op.stepId, i);
      if (step.type !== 'branch')
        fail(i, 'not_a_branch_step', 'Paths go on a branch step.', op.stepId);
      const branches = step.branches as Record<string, unknown>[];
      const index = branches.findIndex((b) => b.id === op.branchId);
      if (index < 0) fail(i, 'branch_not_found', 'That path isn’t on this step.', op.stepId);
      const [removed] = branches.splice(index, 1);
      return {
        op: 'add_branch',
        stepId: op.stepId,
        index,
        branch: removed as unknown as BranchInput,
      };
    }
    case 'set_goto': {
      const { step } = located(work, op.stepId, i);
      if (step.type !== 'goto') fail(i, 'not_a_goto', 'That step isn’t a go-to.', op.stepId);
      const inverse: WorkflowOp = {
        op: 'set_goto',
        stepId: op.stepId,
        target: String(step.target),
        maxVisits: typeof step.maxVisits === 'number' ? step.maxVisits : null,
      };
      step.target = op.target;
      if (op.maxVisits !== null) step.maxVisits = op.maxVisits;
      return inverse;
    }
    case 'set_trigger': {
      const old = cloneJson(work.trigger);
      (work as { trigger: unknown }).trigger = cloneJson(op.trigger);
      return { op: 'set_trigger', trigger: old };
    }
    case 'set_settings': {
      if (!isPlainObject(op.patch)) fail(i, 'bad_patch', 'Settings changes must be an object.');
      const settings = work.settings as unknown as Record<string, unknown>;
      const old: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(op.patch)) {
        if (value === undefined) continue;
        old[key] = cloneJson(settings[key]);
        settings[key] = mergeJson(settings[key], value);
      }
      return { op: 'set_settings', patch: old };
    }
    default: {
      const unknown: { op?: unknown } = op;
      return fail(i, 'invalid', `Unknown op ${String(unknown.op)}.`);
    }
  }
}

/** The ids in a raw step and everything under it. */
function rawIds(step: unknown): string[] {
  if (!isPlainObject(step)) return [];
  const own = typeof step.id === 'string' ? [step.id] : [];
  const lanes: unknown[] = [];
  if (Array.isArray(step.branches))
    for (const b of step.branches)
      if (isPlainObject(b) && Array.isArray(b.steps)) lanes.push(...b.steps);
  if (isPlainObject(step.rejected) && Array.isArray(step.rejected.steps))
    lanes.push(...step.rejected.steps);
  return [...own, ...lanes.flatMap(rawIds)];
}

/** The step ids an op touches, for pinning a batch-level problem on the op most likely to blame. */
function touched(op: WorkflowOp): string[] {
  switch (op.op) {
    case 'add_step':
      return [...(op.parentId ? [op.parentId] : []), ...rawIds(op.step)];
    case 'move_step':
      return [op.stepId, ...(op.parentId ? [op.parentId] : [])];
    case 'set_trigger':
    case 'set_settings':
      return [];
    default:
      return [op.stepId];
  }
}

function blame(
  ops: readonly WorkflowOp[],
  stepId: string | null,
  area: 'trigger' | 'settings' | null,
): number {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!;
    if (area === 'trigger' && op.op === 'set_trigger') return i;
    if (area === 'settings' && op.op === 'set_settings') return i;
    if (stepId && touched(op).includes(stepId)) return i;
  }
  return Math.max(0, ops.length - 1);
}

/** The innermost step a zod issue path runs through. */
function stepAtPath(root: unknown, path: readonly PropertyKey[]): string | null {
  let at: unknown = root;
  let found: string | null = null;
  for (const key of path) {
    if (!at || typeof at !== 'object') break;
    at = (at as Record<PropertyKey, unknown>)[key];
    if (isPlainObject(at) && typeof at.id === 'string' && typeof at.type === 'string')
      found = at.id;
  }
  return found;
}

/** Duplicate ids and misplaced go-tos in a parsed definition. */
export function structureProblems(
  def: WorkflowDefinition,
): { code: 'duplicate_id' | 'goto_not_last'; stepId: string; message: string }[] {
  const out: { code: 'duplicate_id' | 'goto_not_last'; stepId: string; message: string }[] = [];
  const seen = new Set<string>();
  const seenBranches = new Set<string>();
  for (const { step } of allSteps(def)) {
    if (seen.has(step.id))
      out.push({
        code: 'duplicate_id',
        stepId: step.id,
        message: `Two steps share the id ${step.id}.`,
      });
    seen.add(step.id);
    if (step.type === 'branch')
      for (const b of step.branches) {
        if (seenBranches.has(b.id))
          out.push({
            code: 'duplicate_id',
            stepId: step.id,
            message: `Two paths share the id ${b.id}.`,
          });
        seenBranches.add(b.id);
      }
  }
  for (const l of allLanes(def))
    l.steps.forEach((s, index) => {
      if (s.type !== 'goto') return;
      if (l.kind === 'root' || index !== l.steps.length - 1)
        out.push({
          code: 'goto_not_last',
          stepId: s.id,
          message:
            l.kind === 'root'
              ? 'A go-to belongs at the end of a path.'
              : 'A go-to must be the last step of its path.',
        });
    });
  return out;
}

/** Applies ops all or nothing. Throws a WorkflowOpError naming the op that failed. */
export function applyWorkflowOps(def: WorkflowDefinition, ops: readonly WorkflowOp[]): ApplyResult {
  const work = cloneJson(def);
  const inverse: WorkflowOp[] = [];
  ops.forEach((op, i) => inverse.unshift(applyOne(work, op, i)));
  const parsed = WorkflowDefinition.safeParse(work);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => ({
      path: x.path as (string | number)[],
      message: x.message,
    }));
    const first = parsed.error.issues[0]!;
    const stepId = stepAtPath(work, first.path);
    const area =
      first.path[0] === 'trigger' ? 'trigger' : first.path[0] === 'settings' ? 'settings' : null;
    throw new WorkflowOpError(blame(ops, stepId, area), 'invalid', first.message, stepId, issues);
  }
  const [problem] = structureProblems(parsed.data);
  if (problem)
    throw new WorkflowOpError(
      blame(ops, problem.stepId, null),
      problem.code,
      problem.message,
      problem.stepId,
    );
  return { definition: parsed.data, inverse };
}

/**
 * Applies ops without the final parse and structure checks, for previews and for describing a batch op by
 * op. Throws a WorkflowOpError for an op that can't be placed.
 */
export function applyOpsUnchecked(
  def: WorkflowDefinition,
  ops: readonly WorkflowOp[],
): WorkflowDefinition {
  const work = cloneJson(def);
  ops.forEach((op, i) => applyOne(work, op, i));
  return work;
}

/** The steps as a flat list of their ids with where they sit, handy for tests and previews. */
export function outline(def: WorkflowDefinition): string[] {
  return allSteps(def).map((l) => `${'  '.repeat(l.depth)}${l.step.id}:${l.step.type}`);
}
