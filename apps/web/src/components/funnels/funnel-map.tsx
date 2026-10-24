'use client';
import '@xyflow/react/dist/base.css';
/**
 * A funnel's live map (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md, "The map"): a box for each stage with its
 * goal and, once it's on, how many people are there; each message as a line in its stage's box, with its time; and
 * an arrow for each move, labelled with what causes it. Clicking a box opens its stage, a message its messages. The
 * layout is worked out each time from the definition (dagre, top to bottom), never stored.
 */
import dagre from '@dagrejs/dagre';
import {
  funnelMoveCause,
  funnelOnlyIfWords,
  funnelWhenShort,
  type FunnelDefinition,
  type FunnelNames,
} from '@hfos/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';

export interface MapStage {
  readonly id: string;
  readonly name: string;
  readonly kind: 'open' | 'won' | 'lost';
  readonly people?: number;
}

type Part = 'stage' | 'messages';

interface StageData extends Record<string, unknown> {
  readonly stage: MapStage;
  readonly goal: string;
  readonly lines: readonly { readonly id: string; readonly when: string; readonly text: string }[];
  readonly handOff: boolean;
  readonly count: number | null;
  readonly selected: boolean;
  readonly onSelect?: (stageId: string, part: Part) => void;
}

const WIDTH = 248;
/** Below this the text is too small to read, so a long funnel opens at its top rather than all at once. */
const READABLE_ZOOM = 0.75;
const LINE = 36;
const HEAD = 52;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function StageBox({ data }: NodeProps<Node<StageData>>) {
  const { stage, goal, lines, handOff, count, selected, onSelect } = data;
  const closed = stage.kind !== 'open';
  return (
    <div
      className={cn(
        'rounded-card border bg-card text-left shadow-1',
        closed ? 'border-dashed border-border-strong' : 'border-border',
        selected && 'border-accent ring-[3px] ring-ring',
      )}
      style={{ width: WIDTH }}
      data-testid={`funnel-map-stage-${stage.id}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
      <button
        type="button"
        className="block w-full rounded-t-card px-3 pb-1.5 pt-2 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        onClick={() => onSelect?.(stage.id, 'stage')}
      >
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{stage.name}</span>
          {closed ? (
            <span
              className={cn(
                'text-[11px]',
                stage.kind === 'won' ? 'text-success-text' : 'text-text-3',
              )}
            >
              {stage.kind}
            </span>
          ) : null}
          {count !== null && !closed ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-accent-soft px-1.5 text-[11px] font-semibold tabular-nums text-accent-text">
              {count}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate text-[11.5px] text-text-2">
          {closed ? 'They leave the funnel here' : goal ? clip(goal, 60) : 'No goal yet'}
        </span>
      </button>
      {lines.length ? (
        <ul className="border-t border-border">
          {lines.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                className="block w-full px-3 py-1 text-left hover:bg-card-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                style={{ height: LINE }}
                onClick={() => onSelect?.(stage.id, 'messages')}
              >
                <span className="block truncate text-[11px] font-medium text-text-2">{l.when}</span>
                <span className="block truncate text-[11.5px]">{l.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {handOff ? (
        <p className="border-t border-border px-3 py-1 text-[11px] text-text-2">
          Then your team takes over
        </p>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1 !w-1 !border-0 !bg-transparent"
      />
    </div>
  );
}

const NODE_TYPES = { stage: StageBox };
const noop = () => {};

function heightOf(lines: number, handOff: boolean): number {
  return HEAD + lines * LINE + (lines ? 1 : 0) + (handOff ? 22 : 0);
}

interface Built {
  readonly nodes: Node<StageData>[];
  readonly edges: Edge[];
}

function build(
  def: FunnelDefinition,
  stages: readonly MapStage[],
  names: FunnelNames,
  opts: {
    readonly counts: boolean;
    readonly selectedStageId: string | null;
    readonly onSelect?: (stageId: string, part: Part) => void;
  },
): Built {
  const byId = new Map(stages.map((s) => [s.id, s]));
  const inFunnel = def.stages.filter((s) => byId.has(s.stageId));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', ranksep: 64, nodesep: 36, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  const data = new Map<string, StageData>();
  for (const s of inFunnel) {
    const stage = byId.get(s.stageId)!;
    const lines = s.messages.map((m) => ({
      id: m.id,
      when: `${funnelWhenShort(m.when)}${m.onlyIf ? ` · ${funnelOnlyIfWords(m.onlyIf).replace(/^Only if /, 'if ')}` : ''}`,
      text: m.wording === 'exact' ? `“${clip(m.text, 44)}”` : clip(m.text, 46),
    }));
    data.set(s.stageId, {
      stage,
      goal: s.goal,
      lines,
      handOff: s.handOff,
      count: opts.counts ? (stage.people ?? 0) : null,
      selected: opts.selectedStageId === s.stageId,
      onSelect: opts.onSelect,
    });
    g.setNode(s.stageId, { width: WIDTH, height: heightOf(lines.length, s.handOff) });
  }
  // Pipeline order breaks ties, so a straight funnel reads top to bottom as its board does.
  const order = new Map(stages.map((s, i) => [s.id, i]));
  const edges: Edge[] = [];
  for (const s of inFunnel)
    for (const m of s.moves) {
      if (!data.has(m.to)) continue;
      const back = (order.get(m.to) ?? 0) < (order.get(s.stageId) ?? 0);
      if (!back) g.setEdge(s.stageId, m.to);
      edges.push({
        id: `${s.stageId}-${m.id}`,
        source: s.stageId,
        target: m.to,
        type: 'smoothstep',
        label: funnelMoveCause(m, names),
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: back ? { strokeDasharray: '4 4' } : undefined,
        labelStyle: { fontSize: 11 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: 'var(--card)' },
      });
    }
  // Stages nothing joins still read top to bottom in the pipeline's order (dagre only: these aren't drawn).
  const sorted = [...inFunnel].sort(
    (a, b) => (order.get(a.stageId) ?? 0) - (order.get(b.stageId) ?? 0),
  );
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!.stageId;
    const b = sorted[i]!.stageId;
    if (!g.hasEdge(a, b) && !g.hasEdge(b, a)) g.setEdge(a, b, { weight: 0, minlen: 1 });
  }
  dagre.layout(g);
  const nodes: Node<StageData>[] = inFunnel.map((s) => {
    const n = g.node(s.stageId);
    return {
      id: s.stageId,
      type: 'stage',
      position: { x: n.x - n.width / 2, y: n.y - n.height / 2 },
      data: data.get(s.stageId)!,
      draggable: false,
      connectable: false,
    };
  });
  return { nodes, edges };
}

export interface FunnelMapProps {
  readonly definition: FunnelDefinition;
  readonly stages: readonly MapStage[];
  readonly names: FunnelNames;
  /** Show how many people are at each stage (the funnel is on, or has been). */
  readonly counts?: boolean;
  readonly selectedStageId?: string | null;
  readonly onSelect?: (stageId: string, part: Part) => void;
  readonly className?: string;
}

export function FunnelMap(props: FunnelMapProps) {
  return (
    <ReactFlowProvider>
      <MapInner {...props} />
    </ReactFlowProvider>
  );
}

function MapInner({
  definition,
  stages,
  names,
  counts = false,
  selectedStageId = null,
  onSelect,
  className,
}: FunnelMapProps) {
  const { nodes, edges } = useMemo(
    () => build(definition, stages, names, { counts, selectedStageId, onSelect }),
    [definition, stages, names, counts, selectedStageId, onSelect],
  );
  const flow = useReactFlow();
  const box = useRef<HTMLDivElement>(null);
  const shape = nodes.map((n) => n.id).join(',');
  useEffect(() => {
    const t = setTimeout(async () => {
      await flow.fitView({ padding: 0.08, maxZoom: 1 });
      if (flow.getZoom() >= READABLE_ZOOM || !nodes.length) return;
      const left = Math.min(...nodes.map((n) => n.position.x));
      const right = Math.max(...nodes.map((n) => n.position.x + WIDTH));
      const top = Math.min(...nodes.map((n) => n.position.y));
      const width = box.current?.clientWidth ?? 440;
      await flow.setViewport({
        x: (width - (right - left) * READABLE_ZOOM) / 2 - left * READABLE_ZOOM,
        y: 16 - top * READABLE_ZOOM,
        zoom: READABLE_ZOOM,
      });
    }, 30);
    return () => clearTimeout(t);
    // The shape only: a text edit never moves the view.
  }, [flow, shape]);
  return (
    <div
      ref={box}
      className={cn(
        'h-full min-h-[420px] w-full overflow-hidden rounded-card border border-border bg-card-2',
        className,
      )}
      data-testid="funnel-map"
    >
      {nodes.length ? (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          // A click handler gives the boxes pointer events: their own buttons say what was clicked.
          onNodeClick={noop}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
      ) : (
        <p className="p-6 text-center text-[13px] text-text-2">
          The map draws itself as you add the funnel’s stages.
        </p>
      )}
    </div>
  );
}
