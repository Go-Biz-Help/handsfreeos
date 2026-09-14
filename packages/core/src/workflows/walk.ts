/**
 * Walking the workflow tree: finding steps and lanes, what runs next, where a step may be inserted or
 * moved, and which variables a step can use. Pure, shared by the editors, the validator and the engine.
 */
import {
  DATE_ANCHORS,
  TRIGGER_EVENTS,
  aiOutputKey,
  type Step,
  type StepType,
  type WorkflowDefinition,
} from './definition';
import { TEMPLATE_VARIABLES, type TemplateVariable, type VariableSource } from './templates';

/** The branch id of an approval step's "rejected" path. */
export const REJECTED_LANE = 'rejected';

/** Where a list of steps lives: the root (parentId null), a branch's path, or an approval's rejected path. */
export interface LaneRef {
  readonly parentId: string | null;
  readonly branchId: string | null;
}

export type LaneKind = 'root' | 'branch' | 'rejected';

export interface Lane {
  readonly ref: LaneRef;
  readonly kind: LaneKind;
  readonly steps: Step[];
  /** 0 for the root; one more for each branch or approval above. */
  readonly depth: number;
}

export interface ChildLane {
  readonly branchId: string;
  readonly kind: 'branch' | 'rejected';
  readonly steps: Step[];
}

/** A step's own lists of steps: one per branch, or an approval's rejected path. */
export function childLanes(step: Step): ChildLane[] {
  if (step.type === 'branch')
    return step.branches.map((b) => ({ branchId: b.id, kind: 'branch' as const, steps: b.steps }));
  if (step.type === 'approval')
    return [{ branchId: REJECTED_LANE, kind: 'rejected', steps: step.rejected.steps }];
  return [];
}

/** Every lane, parents before children, in document order. */
export function allLanes(def: WorkflowDefinition): Lane[] {
  const out: Lane[] = [];
  const visit = (lane: Lane) => {
    out.push(lane);
    for (const step of lane.steps)
      for (const child of childLanes(step))
        visit({
          ref: { parentId: step.id, branchId: child.branchId },
          kind: child.kind,
          steps: child.steps,
          depth: lane.depth + 1,
        });
  };
  visit({ ref: { parentId: null, branchId: null }, kind: 'root', steps: def.steps, depth: 0 });
  return out;
}

export interface PathSegment {
  readonly stepId: string;
  readonly branchId: string;
}

export interface StepLocation {
  readonly step: Step;
  readonly lane: LaneRef;
  readonly laneKind: LaneKind;
  readonly index: number;
  readonly depth: number;
  /** The containers from the root down to the step's lane. */
  readonly path: readonly PathSegment[];
}

/** Every step with where it is, in document order (a step before its children). */
export function allSteps(def: WorkflowDefinition): StepLocation[] {
  const out: StepLocation[] = [];
  const visit = (steps: Step[], lane: LaneRef, laneKind: LaneKind, path: PathSegment[]) => {
    steps.forEach((step, index) => {
      out.push({ step, lane, laneKind, index, depth: path.length, path });
      for (const child of childLanes(step))
        visit(child.steps, { parentId: step.id, branchId: child.branchId }, child.kind, [
          ...path,
          { stepId: step.id, branchId: child.branchId },
        ]);
    });
  };
  visit(def.steps, { parentId: null, branchId: null }, 'root', []);
  return out;
}

/** The first step with this id, in document order. */
export function findStep(def: WorkflowDefinition, stepId: string): StepLocation | null {
  return allSteps(def).find((l) => l.step.id === stepId) ?? null;
}

/** The containers from the root to a step's lane, or null when there's no such step. */
export function pathTo(def: WorkflowDefinition, stepId: string): PathSegment[] | null {
  const loc = findStep(def, stepId);
  return loc ? [...loc.path] : null;
}

/** The steps of a lane (the live array), or null when it doesn't exist. */
export function laneSteps(def: WorkflowDefinition, lane: LaneRef): Step[] | null {
  if (lane.parentId === null) return lane.branchId === null ? def.steps : null;
  const parent = findStep(def, lane.parentId);
  if (!parent) return null;
  return childLanes(parent.step).find((c) => c.branchId === lane.branchId)?.steps ?? null;
}

export function laneKindOf(lane: LaneRef): LaneKind {
  return lane.parentId === null ? 'root' : lane.branchId === REJECTED_LANE ? 'rejected' : 'branch';
}

/** The ids of a step and everything under it. */
export function subtreeIds(step: Step): string[] {
  return [step.id, ...childLanes(step).flatMap((c) => c.steps.flatMap(subtreeIds))];
}

export function countSteps(steps: readonly Step[]): number {
  return steps.reduce(
    (n, s) => n + 1 + childLanes(s).reduce((m, c) => m + countSteps(c.steps), 0),
    0,
  );
}

// ---- What runs next ----

export interface StepOutcome {
  /** Branch steps: the path taken. */
  readonly branchId?: string;
  /** Approval steps: false follows the rejected path. */
  readonly approved?: boolean;
  /** Go-to steps: how many times this go-to has already jumped in the run. */
  readonly visits?: number;
}

export type NextStep =
  | { readonly kind: 'step'; readonly stepId: string }
  | { readonly kind: 'end'; readonly reason: 'finished' | 'end_step' | 'rejected' };

/** After the last step of a lane: the step after its branch block, or the end of the run. */
function continueAfter(def: WorkflowDefinition, loc: StepLocation): NextStep {
  const siblings = laneSteps(def, loc.lane) ?? [];
  const next = siblings[loc.index + 1];
  if (next) return { kind: 'step', stepId: next.id };
  if (loc.laneKind === 'root') return { kind: 'end', reason: 'finished' };
  if (loc.laneKind === 'rejected') return { kind: 'end', reason: 'rejected' };
  const container = findStep(def, loc.lane.parentId!);
  return container ? continueAfter(def, container) : { kind: 'end', reason: 'finished' };
}

/**
 * The step to run after `stepId`. A branch enters the chosen path (an empty path goes straight past the
 * block); after a path's last step the run continues with the step after the branch block. A go-to jumps
 * until it has jumped `maxVisits` times, then the run carries on past it. A rejected approval runs its
 * rejected path, then the run ends.
 */
export function nextStep(
  def: WorkflowDefinition,
  stepId: string,
  outcome: StepOutcome = {},
): NextStep {
  const loc = findStep(def, stepId);
  if (!loc) throw new RangeError(`No step ${stepId} in this workflow.`);
  const step = loc.step;
  switch (step.type) {
    case 'end':
      return { kind: 'end', reason: 'end_step' };
    case 'branch': {
      const branch = step.branches.find((b) => b.id === outcome.branchId);
      if (!branch) throw new RangeError(`Branch step ${stepId} has no path ${outcome.branchId}.`);
      const first = branch.steps[0];
      return first ? { kind: 'step', stepId: first.id } : continueAfter(def, loc);
    }
    case 'approval': {
      if (outcome.approved !== false) return continueAfter(def, loc);
      const first = step.rejected.steps[0];
      return first ? { kind: 'step', stepId: first.id } : { kind: 'end', reason: 'rejected' };
    }
    case 'goto': {
      const visits = outcome.visits ?? 0;
      if (visits < step.maxVisits && findStep(def, step.target))
        return { kind: 'step', stepId: step.target };
      return continueAfter(def, loc);
    }
    default:
      return continueAfter(def, loc);
  }
}

// ---- Where steps can go ----

export interface InsertionPoint extends LaneRef {
  readonly index: number;
  readonly afterStepId: string | null;
  readonly beforeStepId: string | null;
}

/**
 * Every "+" slot: never after a go-to (it must stay last) or after an end (nothing there runs). A go-to
 * can only go at the end of a branch or rejected path.
 */
export function insertionPoints(def: WorkflowDefinition, forType?: StepType): InsertionPoint[] {
  const out: InsertionPoint[] = [];
  for (const lane of allLanes(def)) {
    const steps = lane.steps;
    const endAt = steps.findIndex((s) => s.type === 'end');
    const limit =
      endAt >= 0 ? endAt : steps.at(-1)?.type === 'goto' ? steps.length - 1 : steps.length;
    for (let index = 0; index <= limit; index++) {
      if (forType === 'goto' && (lane.kind === 'root' || index !== steps.length)) continue;
      out.push({
        ...lane.ref,
        index,
        afterStepId: steps[index - 1]?.id ?? null,
        beforeStepId: steps[index]?.id ?? null,
      });
    }
  }
  return out;
}

export type MoveProblem =
  'step_not_found' | 'lane_not_found' | 'move_into_self' | 'index_out_of_range' | 'goto_not_last';

/** Why a step can't move to `index` of a lane (the index after it's taken out), or null when it can. */
export function moveProblem(
  def: WorkflowDefinition,
  stepId: string,
  to: LaneRef & { readonly index: number },
): MoveProblem | null {
  const loc = findStep(def, stepId);
  if (!loc) return 'step_not_found';
  if (to.parentId !== null && subtreeIds(loc.step).includes(to.parentId)) return 'move_into_self';
  const target = laneSteps(def, to);
  if (!target) return 'lane_not_found';
  const sameLane = loc.lane.parentId === to.parentId && loc.lane.branchId === to.branchId;
  const rest = sameLane ? target.filter((s) => s.id !== stepId) : target;
  if (!Number.isInteger(to.index) || to.index < 0 || to.index > rest.length)
    return 'index_out_of_range';
  if (loc.step.type === 'goto' && (to.parentId === null || to.index !== rest.length))
    return 'goto_not_last';
  if (rest.at(-1)?.type === 'goto' && to.index === rest.length) return 'goto_not_last';
  return null;
}

export function canMove(
  def: WorkflowDefinition,
  stepId: string,
  to: LaneRef & { readonly index: number },
): boolean {
  return moveProblem(def, stepId, to) === null;
}

// ---- Variables ----

/** The steps that surely ran before this one: earlier steps in its lane and in each lane above. */
export function stepsBefore(def: WorkflowDefinition, stepId: string | null): Step[] {
  if (stepId === null) return [];
  const loc = findStep(def, stepId);
  if (!loc) return [];
  const out: Step[] = [];
  let lane: Step[] = def.steps;
  for (const seg of loc.path) {
    const at = lane.findIndex((s) => s.id === seg.stepId);
    out.push(...lane.slice(0, at));
    const container = lane[at]!;
    lane = childLanes(container).find((c) => c.branchId === seg.branchId)!.steps;
  }
  out.push(...lane.slice(0, loc.index));
  return out;
}

/** The records a run has from its trigger (the person always). */
export function triggerRecords(def: WorkflowDefinition): Set<VariableSource> {
  const records = new Set<VariableSource>(['person', 'business', 'links', 'workflow']);
  const t = def.trigger;
  if (t.kind === 'event') for (const r of TRIGGER_EVENTS[t.event].provides) records.add(r);
  if (t.kind === 'date') {
    const record = DATE_ANCHORS[t.anchor].record;
    if (record !== 'person') records.add(record);
  }
  return records;
}

/** The variables a step can use: the trigger's records, a lead created earlier, and earlier AI results. */
export function variablesAt(def: WorkflowDefinition, stepId: string | null): TemplateVariable[] {
  const sources = triggerRecords(def);
  const ai: TemplateVariable[] = [];
  for (const s of stepsBefore(def, stepId)) {
    if (s.type === 'action' && s.action === 'create_lead') sources.add('lead');
    if (
      s.type === 'wait' &&
      s.until.kind === 'event' &&
      s.until.events.includes('message.received')
    )
      sources.add('conversation');
    if (s.type === 'ai') {
      const key = aiOutputKey(s);
      if (!ai.some((v) => v.path === `ai.${key}`))
        ai.push({ path: `ai.${key}`, label: `AI ${s.task} result`, source: 'ai', example: '…' });
    }
  }
  return [...TEMPLATE_VARIABLES.filter((v) => sources.has(v.source)), ...ai];
}
