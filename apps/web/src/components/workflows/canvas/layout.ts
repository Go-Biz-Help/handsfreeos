/**
 * Where everything sits on the canvas, top to bottom in tree order. Every node of a kind has the same size, so
 * the layout depends only on the graph's structure; the canvas memoises it on `structureKey` and text edits
 * never move anything. Positions are worked out each time and never stored.
 *
 * dagre picks each node's row. Across, every path is one straight column, worked out from the tree: a branch's
 * paths sit side by side in tree order with its split and join centred over them, and an approval's next step
 * sits right under it, with its rejected path as a side chain to the right. (dagre's own placement centres a
 * node over all of its children, which pushed everything after an approval sideways.)
 */
import dagre from '@dagrejs/dagre';
import { flowGeometry, type EdgeGeometry } from './geometry';
import {
  joinId,
  TRIGGER_NODE,
  type GraphFlowEdge,
  type GraphNode,
  type GraphNodeKind,
  type WorkflowGraph,
} from './graph';

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const NODE_SIZE: Readonly<Record<GraphNodeKind, Size>> = {
  trigger: { width: 248, height: 52 },
  step: { width: 232, height: 52 },
  split: { width: 248, height: 44 },
  end: { width: 96, height: 32 },
  join: { width: 16, height: 16 },
  terminal: { width: 96, height: 32 },
  empty: { width: 128, height: 32 },
};

const RANK_GAP = 58;
const NODE_GAP = 40;
const MARGIN = 24;
/** The go-tos' tracks run down the right-hand side, this far apart. */
export const GOTO_TRACK_GAP = 14;

export interface GraphLayout {
  /** Top-left corners, in canvas units. */
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly width: number;
  readonly height: number;
  /** Where the first go-to's track runs (the next ones step right). */
  readonly trackX: number;
}

export function layoutGraph(graph: WorkflowGraph): GraphLayout {
  // Rows: dagre, top to bottom. Go-to edges stay out (they point back up); ties keep a path that finishes
  // early above its join. Its crossing heuristic is off: it only ranks here, and that keeps it quick.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', ranksep: RANK_GAP, marginy: MARGIN });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { ...NODE_SIZE[n.kind] });
  for (const e of graph.edges)
    if (e.kind === 'flow')
      g.setEdge(e.source, e.target, { weight: e.shape === 'straight' ? 4 : 1, minlen: 1 });
  for (const t of graph.ties) g.setEdge(t.source, t.target, { weight: 0, minlen: 1 });
  dagre.layout(g, { disableOptimalOrderHeuristic: true });

  // Every node in a row has the same middle, so the middles number the rows.
  const middles = new Map(graph.nodes.map((n) => [n.id, (g.node(n.id) as { y: number }).y]));
  const rowOf = new Map(
    [...new Set(middles.values())].sort((a, b) => a - b).map((y, i) => [y, i] as const),
  );
  const across = columns(graph, (id) => rowOf.get(middles.get(id) ?? 0) ?? 0);

  let left = Number.POSITIVE_INFINITY;
  for (const n of graph.nodes)
    left = Math.min(left, (across.get(n.id) ?? 0) - NODE_SIZE[n.kind].width / 2);
  const positions = new Map<string, { x: number; y: number }>();
  let right = 0;
  let bottom = 0;
  for (const n of graph.nodes) {
    const size = NODE_SIZE[n.kind];
    const x = Math.round((across.get(n.id) ?? 0) - left + MARGIN - size.width / 2);
    const y = Math.round((middles.get(n.id) ?? 0) - size.height / 2);
    positions.set(n.id, { x, y });
    right = Math.max(right, x + size.width);
    bottom = Math.max(bottom, y + size.height);
  }
  return {
    positions,
    width: right + MARGIN,
    height: bottom + MARGIN,
    trackX: right + 28,
  };
}

/** Part of the layout, across: each node's middle, and how far it reaches either side in each row. */
interface Shape {
  readonly x: Map<string, number>;
  readonly left: Map<number, number>;
  readonly right: Map<number, number>;
}

const shape = (): Shape => ({ x: new Map(), left: new Map(), right: new Map() });

/** Takes up `from`..`to` across in a row. */
function reach(s: Shape, row: number, from: number, to: number): void {
  s.left.set(row, Math.min(s.left.get(row) ?? from, from));
  s.right.set(row, Math.max(s.right.get(row) ?? to, to));
}

/** Adds `part`, moved `dx` across. */
function merge(into: Shape, part: Shape, dx: number): void {
  for (const [id, x] of part.x) into.x.set(id, x + dx);
  for (const [row, l] of part.left) reach(into, row, l + dx, (part.right.get(row) ?? l) + dx);
}

/** How far across `part` must move to sit a gap clear of `s` in every row they share. */
function clearance(s: Shape, part: Shape): number {
  let dx = Number.NEGATIVE_INFINITY;
  for (const [row, l] of part.left) {
    const r = s.right.get(row);
    if (r !== undefined) dx = Math.max(dx, r + NODE_GAP - l);
  }
  return dx;
}

/**
 * Each node's middle across, from the tree: every path is one column. The main path starts with the trigger
 * and ends with its End; a join goes with its split.
 */
function columns(graph: WorkflowGraph, row: (id: string) => number): Map<string, number> {
  const lanes = new Map<string, GraphNode[]>();
  /** The paths inside each branch (in order) or approval (its rejected path). */
  const inside = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (n.kind === 'join') continue;
    const parent = n.lane?.parentId ?? null;
    const key = parent === null ? '' : `${parent}|${n.lane?.branchId ?? ''}`;
    let nodes = lanes.get(key);
    if (!nodes) {
      lanes.set(key, (nodes = []));
      if (parent !== null) inside.set(parent, [...(inside.get(parent) ?? []), key]);
    }
    nodes.push(n);
  }

  /**
   * One path as a column at 0, with everything that hangs off it. Its line runs from row `from` (just under
   * what it hangs from) to its last node, or on to row `to` when it runs down into a join, and nothing else
   * may sit on it.
   */
  const column = (key: string, from: number, to = -1): Shape => {
    const s = shape();
    const nodes = lanes.get(key) ?? [];
    const approvals: GraphNode[] = [];
    for (const n of nodes) {
      const half = NODE_SIZE[n.kind].width / 2;
      s.x.set(n.id, 0);
      reach(s, row(n.id), -half, half);
      if (n.kind === 'split') {
        // Its paths side by side, each clear of those before it, and the split and join centred over them.
        const join = joinId(n.id);
        const block = shape();
        let last = 0;
        (inside.get(n.id) ?? []).forEach((k, i) => {
          const tail = lanes.get(k)?.at(-1);
          const open = tail?.kind !== 'end' && tail?.stepType !== 'goto';
          const path = column(k, row(n.id) + 1, open ? row(join) - 1 : -1);
          last = i === 0 ? 0 : clearance(block, path);
          merge(block, path, last);
        });
        merge(s, block, -Math.round(last / 2));
        s.x.set(join, 0);
        reach(s, row(join), -NODE_SIZE.join.width / 2, NODE_SIZE.join.width / 2);
      } else if (n.stepType === 'approval') approvals.push(n);
    }
    const end = Math.max(to, nodes.length ? row(nodes[nodes.length - 1]!.id) : from);
    for (let r = from; r <= end; r++) reach(s, r, 0, 0);
    // Rejected paths go to the right, clear of their approval and of everything beside them. The lowest
    // goes first, so none runs across another's edge.
    for (const a of approvals.reverse()) {
      const k = inside.get(a.id)?.[0];
      const first = k ? lanes.get(k)?.[0] : undefined;
      if (!k || !first) continue;
      const side = column(k, row(a.id) + 1);
      const beside = NODE_SIZE[a.kind].width / 2 + NODE_GAP + NODE_SIZE[first.kind].width / 2;
      merge(s, side, Math.max(beside, clearance(s, side)));
    }
    return s;
  };

  return column('', row(TRIGGER_NODE)).x;
}

/** Where a flow edge runs, from the layout (the drawn edge works it out from its handles, the same way). */
export function edgeGeometryFromLayout(
  edge: GraphFlowEdge,
  layout: GraphLayout,
  kindOf: (id: string) => GraphNodeKind,
): EdgeGeometry | null {
  const s = layout.positions.get(edge.source);
  const t = layout.positions.get(edge.target);
  if (!s || !t) return null;
  const ss = NODE_SIZE[kindOf(edge.source)];
  const ts = NODE_SIZE[kindOf(edge.target)];
  return flowGeometry(
    edge.shape,
    { x: s.x + ss.width / 2, y: s.y + ss.height },
    { x: t.x + ts.width / 2, y: t.y },
  );
}
