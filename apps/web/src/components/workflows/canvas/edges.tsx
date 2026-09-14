'use client';
import { EdgeLabelRenderer, type Edge, type EdgeProps, type EdgeTypes } from '@xyflow/react';
import { CornerUpLeft } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import { AddStepMenu } from '../add-step-menu';
import { laneColor } from '../chips';
import { useCanvas } from './context';
import { flowGeometry, gotoGeometry } from './geometry';
import type { GraphFlowEdge, GraphGotoEdge } from './graph';

export interface FlowEdgeData extends Record<string, unknown> {
  readonly edge: GraphFlowEdge;
  /** Into a step or an end (not into a join). */
  readonly arrow: boolean;
  /** A step being dragged over this edge's "+": whether it can go there. */
  readonly drop: 'ok' | 'bad' | null;
}

export interface GotoEdgeData extends Record<string, unknown> {
  readonly edge: GraphGotoEdge;
  /** Where this go-to's track runs down the right-hand side. */
  readonly trackX: number;
}

export type CanvasFlowEdge = Edge<FlowEdgeData, 'flow'>;
export type CanvasGotoEdge = Edge<GotoEdgeData, 'goto'>;
export type CanvasEdge = CanvasFlowEdge | CanvasGotoEdge;

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

/** A go-to's dashed edge back to its target, with how many times it goes back. */
const GotoEdgeView = memo(function GotoEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<CanvasGotoEdge>) {
  if (!data) return null;
  const { edge, trackX } = data;
  const geo = gotoGeometry({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, trackX);
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

/** One set for the canvas's lifetime, so xyflow never remounts the edges. */
export const EDGE_TYPES = { flow: FlowEdgeView, goto: GotoEdgeView } satisfies EdgeTypes;
