'use client';
import {
  EdgeLabelRenderer,
  useInternalNode,
  ViewportPortal,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type InternalNode,
} from '@xyflow/react';
import { CornerUpLeft } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { AddStepMenu } from '../add-step-menu';
import { laneColor } from '../chips';
import { useCanvas } from './context';
import { flowGeometry, gotoGeometry, type Pt } from './geometry';
import type { GraphFlowEdge, GraphGotoEdge } from './graph';

export interface FlowEdgeData extends Record<string, unknown> {
  readonly edge: GraphFlowEdge;
  /** Into a step or an end (not into a join). */
  readonly arrow: boolean;
  /** A step being dragged over this edge's "+": whether it can go there. */
  readonly drop: 'ok' | 'bad' | null;
}

export type CanvasFlowEdge = Edge<FlowEdgeData, 'flow'>;
/** The edges xyflow draws. Go-tos have their own layer: see `GotoEdges`. */
export type CanvasEdge = CanvasFlowEdge;

/** A go-to's dashed edge, and where its track runs down the right-hand side. */
export interface GotoLine {
  readonly edge: GraphGotoEdge;
  readonly trackX: number;
}

const at = (x: number, y: number) => ({
  transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
});

/** An edge between steps: its path's name where a path starts, and its "+" (the same menu as Steps). */
const FlowEdgeView = memo(function FlowEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<CanvasFlowEdge>) {
  const { def, editable, insert } = useCanvas();
  if (!data) return null;
  const { edge, drop } = data;
  const geo = flowGeometry(
    edge.shape,
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    data.arrow,
  );
  const point = editable ? edge.point : null;
  const label = edge.label;
  return (
    <>
      <path d={geo.path} className="wf-edge" fill="none" />
      {geo.arrow ? <path d={geo.arrow} className="wf-arrow" /> : null}
      {label || point ? (
        <EdgeLabelRenderer>
          <div className="nodrag nopan wf-edge-tools" style={at(geo.slot.x, geo.slot.y)}>
            {label ? (
              <span
                className={cn(
                  'wf-edge-label',
                  label.tone === 'rejected' && 'wf-edge-label-rejected',
                )}
                title={label.title ?? undefined}
                data-testid="canvas-edge-label"
                data-branch-id={label.branchId}
              >
                {label.tone === 'rejected' ? null : (
                  <i style={{ background: laneColor(label.index, label.tone === 'otherwise') }} />
                )}
                {label.text}
              </span>
            ) : null}
            {point ? (
              drop ? (
                <span className={cn('wf-drop', drop === 'bad' && 'wf-drop-bad')}>
                  {drop === 'ok' ? 'Move here' : 'Can’t go here'}
                </span>
              ) : (
                <AddStepMenu
                  def={def}
                  at={point}
                  onPick={(kind, text) => insert(point, kind, text)}
                />
              )
            ) : null}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
});

/**
 * Where a node's handle on its right-hand side meets an edge: from the handle as measured on screen, or as
 * given before the node is drawn (the same as xyflow works it out for its own edges).
 */
function rightHandle(node: InternalNode | undefined, id: string): Pt | null {
  if (!node) return null;
  const bounds = node.internals.handleBounds;
  const handle =
    [...(bounds?.source ?? []), ...(bounds?.target ?? [])].find((h) => h.id === id) ??
    node.handles?.find((h) => h.id === id);
  if (!handle) return null;
  const { x, y } = node.internals.positionAbsolute;
  return { x: x + handle.x + (handle.width ?? 0), y: y + handle.y + (handle.height ?? 0) / 2 };
}

/** A go-to's dashed edge back to its target, with how many times it goes back. */
const GotoEdgeView = memo(function GotoEdgeView({ edge, trackX }: GotoLine) {
  const source = useInternalNode(edge.source);
  const target = useInternalNode(edge.target);
  const s = rightHandle(source, 'goto');
  const t = rightHandle(target, 'goto-in');
  if (!s || !t) return null;
  const geo = gotoGeometry(s, t, trackX);
  const times = edge.maxVisits === 1 ? '1 time' : `${edge.maxVisits} times`;
  return (
    <>
      <path d={geo.path} className="wf-edge wf-edge-goto" fill="none" />
      {geo.arrow ? <path d={geo.arrow} className="wf-arrow wf-arrow-goto" /> : null}
      <EdgeLabelRenderer>
        <span
          className="nodrag nopan wf-edge-tools wf-goto-label"
          style={at(geo.slot.x, geo.slot.y)}
          data-testid={`canvas-goto-${edge.source}`}
          data-target={edge.target}
        >
          <CornerUpLeft className="h-3 w-3" strokeWidth={1.75} />
          Back · {times} max
        </span>
      </EdgeLabelRenderer>
    </>
  );
});

/**
 * The go-tos' dashed edges, on a layer of their own above the steps. The canvas draws only what's on screen,
 * and xyflow drops an edge when neither end's node is in view; a go-to runs out along its track, well clear of
 * both, so it vanished while its line still crossed the screen. There are only ever a few, so they're always
 * drawn, from the nodes' live positions (so they follow a drag).
 */
export const GotoEdges = memo(function GotoEdges({ lines }: { lines: readonly GotoLine[] }) {
  if (!lines.length) return null;
  return (
    <ViewportPortal>
      <svg className="wf-goto-edges" aria-hidden="true">
        {lines.map((l) => (
          <GotoEdgeView key={l.edge.id} edge={l.edge} trackX={l.trackX} />
        ))}
      </svg>
    </ViewportPortal>
  );
});

/** One set for the canvas's lifetime, so xyflow never remounts the edges. */
export const EDGE_TYPES = { flow: FlowEdgeView } satisfies EdgeTypes;
