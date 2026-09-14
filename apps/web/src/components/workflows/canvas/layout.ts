/**
 * Where everything sits on the canvas: dagre, top to bottom, in tree order. Every node of a kind has the same
 * size, so the layout depends only on the graph's structure; the canvas memoises it on `structureKey` and
 * text edits never move anything. Positions are worked out each time and never stored.
 */
import dagre from '@dagrejs/dagre';
import { flowGeometry, type EdgeGeometry } from './geometry';
import type { GraphFlowEdge, GraphNodeKind, WorkflowGraph } from './graph';

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
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: NODE_GAP,
    ranksep: RANK_GAP,
    marginx: MARGIN,
    marginy: MARGIN,
  });
  g.setDefaultEdgeLabel(() => ({}));
  // Nodes and edges go in in tree order, and dagre keeps that order (its crossing heuristic is off), so
  // paths sit left to right as they do in Steps. Go-to edges stay out: they point back up.
  for (const n of graph.nodes) g.setNode(n.id, { ...NODE_SIZE[n.kind] });
  for (const e of graph.edges)
    if (e.kind === 'flow')
      g.setEdge(e.source, e.target, { weight: e.shape === 'straight' ? 4 : 1, minlen: 1 });
  for (const t of graph.ties) g.setEdge(t.source, t.target, { weight: 0, minlen: 1 });
  dagre.layout(g, { disableOptimalOrderHeuristic: true });

  const positions = new Map<string, { x: number; y: number }>();
  let right = 0;
  let bottom = 0;
  for (const n of graph.nodes) {
    const at = g.node(n.id) as { x: number; y: number };
    const size = NODE_SIZE[n.kind];
    const x = Math.round(at.x - size.width / 2);
    const y = Math.round(at.y - size.height / 2);
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
