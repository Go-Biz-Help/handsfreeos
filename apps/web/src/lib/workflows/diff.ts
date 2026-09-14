import {
  allSteps,
  applyOpsUnchecked,
  applyWorkflowOps,
  type Step,
  type StepLocation,
  type WorkflowDefinition,
  type WorkflowOp,
} from '@hfos/core';
import type { StepOverlay } from '@/components/workflows/step-list';
import { sameJson } from './patches';

/** A proposal drawn for review: the workflow it makes, with each step marked new, changed or removed. */
export interface ProposalView {
  /** The workflow once the ops are applied. */
  readonly result: WorkflowDefinition;
  /** What the preview draws: the result, with removed steps left where they were so they show as removed. */
  readonly shown: WorkflowDefinition;
  readonly overlays: Readonly<Record<string, StepOverlay>>;
  readonly counts: { readonly added: number; readonly changed: number; readonly removed: number };
}

/** A step without the steps inside it, to compare what the step itself says. */
function face(step: Step): unknown {
  if (step.type === 'branch')
    return { ...step, branches: step.branches.map((b) => ({ ...b, steps: [] })) };
  if (step.type === 'approval') return { ...step, rejected: { steps: [] } };
  return step;
}

const sameLane = (a: StepLocation, b: StepLocation) =>
  a.lane.parentId === b.lane.parentId && a.lane.branchId === b.lane.branchId;

/**
 * The review of a proposal against the draft it was made for. Null when the ops don't apply to it any more
 * (the draft moved on), so the proposal can't be applied either.
 */
export function proposalView(
  base: WorkflowDefinition,
  ops: readonly WorkflowOp[],
): ProposalView | null {
  let result: WorkflowDefinition;
  try {
    result = applyWorkflowOps(base, ops).definition;
  } catch {
    return null;
  }
  const before = new Map(allSteps(base).map((l) => [l.step.id, l]));
  const after = new Map(allSteps(result).map((l) => [l.step.id, l]));
  const overlays: Record<string, StepOverlay> = {};
  let added = 0;
  let changed = 0;
  for (const [id, loc] of after) {
    const old = before.get(id);
    if (!old) {
      overlays[id] = { status: 'added' };
      // Steps inside a new step come with it.
      if (!loc.path.some((p) => !before.has(p.stepId))) added += 1;
      continue;
    }
    const edited = !sameJson(face(old.step), face(loc.step));
    const moved = !sameLane(old, loc);
    if (edited || moved) {
      overlays[id] = { status: 'changed', ...(moved && !edited ? { note: 'Moved here' } : {}) };
      changed += 1;
    }
  }
  const gone = [...before.keys()].filter((id) => !after.has(id));
  let removed = 0;
  let shown = result;
  if (gone.length) {
    // Everything but the removals, so the removed steps can be drawn where they were.
    const deletes = new Set(gone);
    try {
      const kept = applyOpsUnchecked(
        base,
        ops.filter((o) => !(o.op === 'delete_step' && deletes.has(o.stepId))),
      );
      const keptIds = new Set(allSteps(kept).map((l) => l.step.id));
      if ([...after.keys()].every((id) => keptIds.has(id))) {
        shown = kept;
        for (const id of gone) if (keptIds.has(id)) overlays[id] = { status: 'removed' };
      }
    } catch {
      // Drawn without them; the list of changes still names them.
    }
    removed = gone.filter((id) => {
      const loc = before.get(id)!;
      return !loc.path.some((p) => deletes.has(p.stepId));
    }).length;
  }
  return { result, shown, overlays, counts: { added, changed, removed } };
}
