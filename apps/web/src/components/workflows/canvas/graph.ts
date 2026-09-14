/**
 * The canvas's view of a workflow: the one tree, as a graph. Pure (no React, no positions), so the layout,
 * the drop targets and the spec all read the same thing.
 *
 * Nodes: the trigger; one per step, where a branch step is the split its paths fan out from; a join per
 * branch block, where the paths meet again; a "No steps yet" placeholder for an empty path; and the ends
 * (after the main path, and "Run ends" after an approval's rejected path).
 *
 * Edges run between them in tree order and are labelled with the path they start (its name, with the
 * condition as the title). Every edge between two places a step can go carries a "+" that is one of core's
 * `insertionPoints`, so whatever is added there is valid by construction. A go-to gets a dashed edge to its
 * target, and an approval's rejected path gets its own edge.
 */
import {
  describeConditions,
  insertionPoints,
  REJECTED_LANE,
  type ApprovalStep,
  type BranchStep,
  type GotoStep,
  type InsertionPoint,
  type LaneRef,
  type Step,
  type StepType,
  type WorkflowDefinition,
  type WorkflowNames,
} from '@hfos/core';

export type GraphNodeKind = 'trigger' | 'step' | 'split' | 'end' | 'join' | 'terminal' | 'empty';

export interface GraphNode {
  readonly id: string;
  readonly kind: GraphNodeKind;
  /** The step it shows; null for the trigger, joins, ends and placeholders. */
  readonly stepId: string | null;
  readonly stepType: StepType | null;
  /** Where the step (or placeholder) sits. */
  readonly lane: LaneRef | null;
  readonly index: number | null;
  /** 0 on the main path, one more inside each branch or rejected path. */
  readonly depth: number;
  /** Ends and placeholders: what they say. */
  readonly label: string | null;
}

export type EdgeLabelTone = 'branch' | 'otherwise' | 'rejected';

export interface GraphEdgeLabel {
  readonly text: string;
  readonly tone: EdgeLabelTone;
  /** The path's place among its siblings, for the colour Steps gives it. */
  readonly index: number;
  /** The path's condition (or what the AI reads to pick it), in words. */
  readonly title: string | null;
  /** The branch this edge starts, or `rejected`. */
  readonly branchId: string;
}

/** Where a flow edge bends: `split` just below its source (paths fanning out), `join` just above its target. */
export type EdgeShape = 'straight' | 'split' | 'join';

export interface GraphFlowEdge {
  readonly kind: 'flow';
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly shape: EdgeShape;
  readonly label: GraphEdgeLabel | null;
  /** The "+" on this edge: a core insertion point, or null where nothing can go (after an End). */
  readonly point: InsertionPoint | null;
}

export interface GraphGotoEdge {
  readonly kind: 'goto';
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly maxVisits: number;
  /** Which go-to this is (0, 1, …), so each gets its own track down the right-hand side. */
  readonly track: number;
}

export type GraphEdge = GraphFlowEdge | GraphGotoEdge;

export interface WorkflowGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /**
   * Layout-only links, never drawn: a path that finishes with a go-to or End still sits above its join, and so
   * does the rejected path of an approval inside a branch.
   */
  readonly ties: readonly { readonly source: string; readonly target: string }[];
}

export const TRIGGER_NODE = 'trigger';
export const END_NODE = 'end';
export const joinId = (branchStepId: string): string => `join:${branchStepId}`;
export const emptyId = (lane: LaneRef): string =>
  `empty:${lane.parentId ?? 'root'}:${lane.branchId ?? ''}`;
export const rejectedEndId = (approvalId: string): string => `rejected-end:${approvalId}`;
export const gotoEdgeId = (gotoStepId: string): string => `goto:${gotoStepId}`;

const pointKey = (lane: LaneRef, index: number): string =>
  `${lane.parentId ?? ''}|${lane.branchId ?? ''}|${index}`;

/** The graph of a workflow's tree: see the top of this file. */
export function treeToGraph(def: WorkflowDefinition, names: WorkflowNames = {}): WorkflowGraph {
  const points = new Map<string, InsertionPoint>();
  for (const p of insertionPoints(def)) points.set(pointKey(p, p.index), p);
  const pointAt = (lane: LaneRef, index: number) => points.get(pointKey(lane, index)) ?? null;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const ties: { source: string; target: string }[] = [];
  const gotos: GotoStep[] = [];
  // Rejected paths are walked last, after the path their approval is on (the layout puts them beside it, to
  // the right). `join` is where that path runs into (null on the main path): a rejected path stays above it.
  const rejected: { step: ApprovalStep; depth: number; join: string | null }[] = [];

  const node = (n: Omit<GraphNode, 'stepId' | 'stepType' | 'label'> & Partial<GraphNode>) =>
    nodes.push({ stepId: null, stepType: null, label: null, ...n });
  const flow = (
    source: string,
    target: string,
    shape: EdgeShape,
    point: InsertionPoint | null,
    label: GraphEdgeLabel | null = null,
  ) =>
    edges.push({ kind: 'flow', id: `e:${source}>${target}`, source, target, shape, label, point });

  /**
   * Lays out one path from `from`, inside the branch whose `join` it runs into (null on the main path).
   * `tail` is the node the run carries on from after the path, or null when the path finishes itself (a
   * go-to or End); `last` is its last node either way.
   */
  const walk = (
    steps: readonly Step[],
    lane: LaneRef,
    depth: number,
    from: string,
    label: GraphEdgeLabel | null,
    join: string | null,
  ): { tail: string | null; last: string } => {
    let prev = from;
    let open = true;
    steps.forEach((step, index) => {
      node({
        id: step.id,
        kind: step.type === 'branch' ? 'split' : step.type === 'end' ? 'end' : 'step',
        stepId: step.id,
        stepType: step.type,
        lane,
        index,
        depth,
      });
      const first = index === 0 && label !== null;
      flow(prev, step.id, first ? 'split' : 'straight', pointAt(lane, index), first ? label : null);
      prev = step.id;
      if (step.type === 'branch') prev = branchBlock(step, depth);
      else if (step.type === 'approval') rejected.push({ step, depth, join });
      else if (step.type === 'goto') {
        gotos.push(step);
        open = false;
      } else if (step.type === 'end') open = false;
    });
    return { tail: open ? prev : null, last: prev };
  };

  /** A branch step's paths and the join after them; returns the join, where the run carries on. */
  const branchBlock = (step: BranchStep, depth: number): string => {
    const join = joinId(step.id);
    step.branches.forEach((b, i) => {
      const lane: LaneRef = { parentId: step.id, branchId: b.id };
      const label: GraphEdgeLabel = {
        text: b.name,
        tone: b.condition === null && step.mode !== 'ai' ? 'otherwise' : 'branch',
        index: i,
        title: b.condition ? describeConditions(b.condition, names) : b.description,
        branchId: b.id,
      };
      if (!b.steps.length) {
        const id = emptyId(lane);
        node({ id, kind: 'empty', lane, index: 0, depth: depth + 1, label: 'No steps yet' });
        flow(step.id, id, 'split', pointAt(lane, 0), label);
        flow(id, join, 'join', null);
        return;
      }
      const { tail, last } = walk(b.steps, lane, depth + 1, step.id, label, join);
      if (tail) flow(tail, join, 'join', pointAt(lane, b.steps.length));
      else ties.push({ source: last, target: join });
    });
    node({ id: join, kind: 'join', lane: null, index: null, depth });
    return join;
  };

  node({ id: TRIGGER_NODE, kind: 'trigger', lane: null, index: null, depth: 0 });
  const root: LaneRef = { parentId: null, branchId: null };
  const { tail } = walk(def.steps, root, 0, TRIGGER_NODE, null, null);
  if (tail) {
    node({ id: END_NODE, kind: 'terminal', lane: null, index: null, depth: 0, label: 'End' });
    flow(tail, END_NODE, 'straight', pointAt(root, def.steps.length));
  }

  for (let i = 0; i < rejected.length; i++) {
    const { step, depth, join } = rejected[i]!;
    const lane: LaneRef = { parentId: step.id, branchId: REJECTED_LANE };
    const label: GraphEdgeLabel = {
      text: 'If it’s rejected',
      tone: 'rejected',
      index: 0,
      title: 'After these steps, the run ends',
      branchId: REJECTED_LANE,
    };
    const end = rejectedEndId(step.id);
    const steps = step.rejected.steps;
    const endNode = () =>
      node({ id: end, kind: 'terminal', lane, index: null, depth: depth + 1, label: 'Run ends' });
    if (!steps.length) {
      endNode();
      flow(step.id, end, 'split', pointAt(lane, 0), label);
      if (join) ties.push({ source: end, target: join });
      continue;
    }
    const out = walk(steps, lane, depth + 1, step.id, label, join);
    if (out.tail) {
      endNode();
      flow(out.tail, end, 'straight', pointAt(lane, steps.length));
    }
    if (join) ties.push({ source: out.tail ? end : out.last, target: join });
  }

  const stepIds = new Set(nodes.map((n) => n.stepId).filter((id): id is string => id !== null));
  gotos.forEach((g, track) => {
    if (g.target === g.id || !stepIds.has(g.target)) return;
    edges.push({
      kind: 'goto',
      id: gotoEdgeId(g.id),
      source: g.id,
      target: g.target,
      maxVisits: g.maxVisits,
      track,
    });
  });

  return { nodes, edges, ties };
}

/**
 * What the layout depends on: step ids and types and the shape of the paths, nothing else. Editing a
 * message, a wait or a go-to's target leaves it unchanged, so nothing on the canvas moves.
 */
export function structureKey(def: WorkflowDefinition): string {
  const lane = (steps: readonly Step[]): string =>
    steps
      .map((s) => {
        if (s.type === 'branch')
          return `${s.id}:branch{${s.branches.map((b) => `${b.id}[${lane(b.steps)}]`).join('')}}`;
        if (s.type === 'approval') return `${s.id}:approval{${lane(s.rejected.steps)}}`;
        return `${s.id}:${s.type}`;
      })
      .join(',');
  return lane(def.steps);
}

/** A short, stable fingerprint of a structure key (FNV-1a), for a data attribute. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
