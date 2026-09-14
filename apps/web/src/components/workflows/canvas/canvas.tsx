'use client';
import '@xyflow/react/dist/base.css';
import './canvas.css';
import {
  allSteps,
  childLanes,
  countSteps,
  describeTrigger,
  findStep,
  laneSteps,
  moveProblem,
  type InsertionPoint,
  type LaneRef,
  type MoveProblem,
  type StepType,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNames,
} from '@hfos/core';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Connection,
  type NodeChange,
  type NodeMouseHandler,
  type OnConnectEnd,
  type OnNodeDrag,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
import { Eye, Map as MapIcon, Maximize, Minus, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { newStep, stepLines, type NewStepKind } from '@/lib/workflows/steps';
import { cn } from '@/lib/utils';
import { Note } from '../panels/fields';
import type { StepListEditing, StepOverlay } from '../step-list';
import { CanvasProvider, type CanvasContextValue } from './context';
import { EDGE_TYPES, GotoEdges, type CanvasEdge, type GotoLine } from './edges';
import { clientPoint, distance, distanceToPolyline, type Pt } from './geometry';
import { shortHash, structureKey, treeToGraph, TRIGGER_NODE, type GraphNodeKind } from './graph';
import {
  edgeGeometryFromLayout,
  GOTO_TRACK_GAP,
  layoutGraph,
  NODE_SIZE,
  type GraphLayout,
  type Size,
} from './layout';
import { NODE_TYPES, type CanvasNode } from './nodes';

export interface WorkflowCanvasProps {
  readonly definition: WorkflowDefinition;
  /** Names for ids (team, stages, tags…): any of the workflow catalogs. */
  readonly names: WorkflowNames;
  /** Checks, for the same red and amber dots Steps shows. */
  readonly issues?: readonly WorkflowIssue[];
  /** A step id, or 'trigger': the same selection as Steps (`?step=`). */
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string) => void;
  /** The step list's editing hooks; leave them out to only view. */
  readonly editing?: StepListEditing;
  /** Marks on steps, the same shape the step list takes (run detail uses them). */
  readonly overlays?: Readonly<Record<string, StepOverlay>>;
  /** On a phone the canvas only views: pan, zoom and tap to select. Editing happens in Steps. */
  readonly phone?: boolean;
  readonly className?: string;
}

type NodeHandle = NonNullable<CanvasNode['handles']>[number];

const NO_ISSUES: readonly WorkflowIssue[] = [];
const NO_OVERLAYS: Readonly<Record<string, StepOverlay>> = {};
const noop = () => {};
/** Below this the text is too small to read, so a big workflow opens at its top rather than all at once. */
const READABLE_ZOOM = 0.6;
const PAD = 24;
const FIT = { padding: 0.08, maxZoom: 1 } as const;
/** How close (on screen) a dragged step must come to a "+" or an edge to drop there. */
const DROP_REACH = 28;

/** Why a step can't go where it was dropped (core's `moveProblem`, in words). */
export const MOVE_PROBLEMS: Readonly<Record<MoveProblem, string>> = {
  step_not_found: 'That step isn’t in the workflow any more.',
  lane_not_found: 'That place isn’t in the workflow any more.',
  move_into_self: 'A step can’t go inside its own paths.',
  index_out_of_range: 'That spot is outside the path.',
  goto_not_last: 'A go-to must be the last step of its path, and nothing can go after one.',
};

/** Why a go-to can't go back to a step, or null when it can (the same steps the go-to panel offers). */
export function gotoProblem(
  def: WorkflowDefinition,
  gotoId: string,
  targetId: string,
): string | null {
  const from = findStep(def, gotoId)?.step;
  if (!from || from.type !== 'goto')
    return 'Drag from a go-to’s handle to pick where it goes back to.';
  if (targetId === gotoId) return 'A go-to can’t go back to itself.';
  const to = findStep(def, targetId)?.step;
  if (!to) return 'Drop it on the step it should go back to.';
  if (to.type === 'goto' || to.type === 'end')
    return 'A go-to can go back to any step except an End or another go-to.';
  return null;
}

/** The handles each kind of node has, known up front so edges draw even for nodes that aren't on screen. */
function handlesFor(kind: GraphNodeKind, stepType: StepType | null): NodeHandle[] {
  const { width: w, height: h } = NODE_SIZE[kind];
  const out: NodeHandle[] = [];
  const dot = { width: 1, height: 1 };
  if (kind !== 'trigger')
    out.push({ id: 'in', type: 'target', position: Position.Top, x: w / 2 - 0.5, y: -0.5, ...dot });
  if (kind !== 'terminal')
    out.push({
      id: 'out',
      type: 'source',
      position: Position.Bottom,
      x: w / 2 - 0.5,
      y: h - 0.5,
      ...dot,
    });
  if (stepType === 'goto')
    out.push({
      id: 'goto',
      type: 'source',
      position: Position.Right,
      x: w - 7,
      y: h / 2 - 7,
      width: 14,
      height: 14,
    });
  else if (kind === 'step' || kind === 'split')
    out.push({
      id: 'goto-in',
      type: 'target',
      position: Position.Right,
      x: w - 0.5,
      y: h / 2 - 0.5,
      ...dot,
    });
  return out;
}

/**
 * Where the canvas opens: the whole workflow when it's readable that way, otherwise its top (or around
 * the selected step) at a readable zoom.
 */
function initialViewport(
  layout: GraphLayout,
  box: Size,
  focus: (XYPosition & Size) | null,
): { x: number; y: number; zoom: number } {
  const fit = Math.min(
    (box.width - PAD * 2) / layout.width,
    (box.height - PAD * 2) / layout.height,
    1,
  );
  if (fit >= READABLE_ZOOM)
    return {
      x: Math.round((box.width - layout.width * fit) / 2),
      y: Math.round((box.height - layout.height * fit) / 2),
      zoom: fit,
    };
  const zoom = Math.min(0.85, Math.max(READABLE_ZOOM, (box.width - PAD * 2) / layout.width));
  let y = PAD / 2;
  if (focus && (focus.y + focus.height) * zoom + y > box.height - PAD)
    y = box.height / 3 - (focus.y + focus.height / 2) * zoom;
  return { x: Math.round((box.width - layout.width * zoom) / 2), y: Math.round(y), zoom };
}

/**
 * The Canvas editor: the same draft as Steps, as a flowchart. The layout is worked out from the tree
 * (never stored); every gesture becomes the same patch ops Steps makes ("+" on an edge is `add_step`,
 * dropping a step on a "+" is `move_step`, dragging from a go-to's handle is `set_goto`, Delete is
 * `delete_step`), so Undo, Redo and saving are shared. Loaded lazily with `next/dynamic`.
 */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  definition: def,
  names,
  issues = NO_ISSUES,
  selectedId = null,
  onSelect = noop,
  editing,
  overlays = NO_OVERLAYS,
  phone = false,
  className,
}: WorkflowCanvasProps) {
  const flow = useReactFlow<CanvasNode, CanvasEdge>();
  const root = useRef<HTMLDivElement>(null);
  const [startedAt] = useState(() => performance.now());
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [viewportReady, setViewportReady] = useState(false);
  const [minimap, setMinimap] = useState(!phone);
  const [drag, setDrag] = useState<{ id: string; position: XYPosition } | null>(null);
  const [drop, setDrop] = useState<{ edgeId: string; ok: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ stepId: string; title: string; inside: number } | null>(
    null,
  );
  const editable = !!editing && !phone;

  const key = structureKey(def);
  const graph = useMemo(() => treeToGraph(def, names), [def, names]);
  // Positions follow the structure alone: a text edit makes a new graph with the same key, so the cached
  // layout (from an earlier graph of the same shape) still fits and nothing moves.
  const layout = useMemo(() => layoutGraph(graph), [key]);
  const kinds = useMemo(
    () => new Map<string, GraphNodeKind>(graph.nodes.map((n) => [n.id, n.kind])),
    [graph],
  );
  const steps = useMemo(() => new Map(allSteps(def).map((l) => [l.step.id, l.step])), [def]);

  const flags = useMemo(() => {
    const m = new Map<string, WorkflowIssue>();
    for (const i of issues) {
      if (!i.stepId) continue;
      const had = m.get(i.stepId);
      if (!had || (had.severity === 'warning' && i.severity === 'error')) m.set(i.stepId, i);
    }
    return m;
  }, [issues]);
  const triggerFlag = useMemo(() => {
    const about = issues.filter((i) => !i.stepId && i.fields.some((f) => f.startsWith('trigger')));
    return about.find((i) => i.severity === 'error') ?? about[0] ?? null;
  }, [issues]);

  // ---- Nodes and edges ----

  const baseNodes = useMemo(
    () =>
      graph.nodes.map((n): CanvasNode => {
        const step = n.stepId ? (steps.get(n.stepId) ?? null) : null;
        const lines = step
          ? stepLines(step, names, def)
          : {
              title: n.kind === 'trigger' ? describeTrigger(def.trigger, names) : (n.label ?? ''),
              detail: null,
            };
        const selectable = n.kind === 'trigger' || step !== null;
        const size = NODE_SIZE[n.kind];
        return {
          id: n.id,
          type: n.kind,
          position: layout.positions.get(n.id) ?? { x: 0, y: 0 },
          width: size.width,
          height: size.height,
          handles: handlesFor(n.kind, n.stepType),
          data: {
            node: n,
            step,
            trigger: n.kind === 'trigger' ? def.trigger : null,
            title: lines.title,
            detail: lines.detail,
            flag: n.kind === 'trigger' ? triggerFlag : step ? (flags.get(step.id) ?? null) : null,
            overlay: step ? (overlays[step.id] ?? null) : null,
          },
          selected: selectable && n.id === selectedId,
          selectable,
          focusable: selectable,
          draggable: editable && step !== null,
          connectable: editable,
          deletable: false,
        };
      }),
    [graph, layout, steps, names, def, flags, triggerFlag, overlays, selectedId, editable],
  );
  const nodes = useMemo(
    () =>
      drag
        ? baseNodes.map((n) =>
            n.id === drag.id ? { ...n, position: drag.position, zIndex: 1000 } : n,
          )
        : baseNodes,
    [baseNodes, drag],
  );

  const baseEdges = useMemo(
    () =>
      graph.edges.flatMap((e): CanvasEdge[] =>
        e.kind === 'flow'
          ? [
              {
                id: e.id,
                type: 'flow',
                source: e.source,
                target: e.target,
                sourceHandle: 'out',
                targetHandle: 'in',
                selectable: false,
                focusable: false,
                data: { edge: e, arrow: kinds.get(e.target) !== 'join', drop: null },
              },
            ]
          : [],
      ),
    [graph, kinds],
  );
  // Go-tos have their own layer, drawn wherever the canvas is scrolled (see GotoEdges).
  const gotoLines = useMemo(
    () =>
      graph.edges.flatMap((e): GotoLine[] =>
        e.kind === 'goto' ? [{ edge: e, trackX: layout.trackX + e.track * GOTO_TRACK_GAP }] : [],
      ),
    [graph, layout],
  );
  const edges = useMemo(
    () =>
      drop
        ? baseEdges.map((e): CanvasEdge =>
            e.type === 'flow' && e.id === drop.edgeId && e.data
              ? { ...e, data: { ...e.data, drop: drop.ok ? 'ok' : 'bad' } }
              : e,
          )
        : baseEdges,
    [baseEdges, drop],
  );

  // ---- Edits: every one is a patch op on the shared draft ----

  const insert = useCallback(
    (at: InsertionPoint, kind: NewStepKind, label: string) => {
      if (!editing) return;
      const step = newStep(kind, {
        def,
        catalogs: editing.catalogs,
        at,
        workflowId: editing.workflowId,
      });
      const out = editing.apply(
        [{ op: 'add_step', parentId: at.parentId, branchId: at.branchId, index: at.index, step }],
        `Add “${label}”`,
      );
      if (out.ok) onSelect(step.id);
    },
    [def, editing, onSelect],
  );

  const removeNow = useCallback(
    (stepId: string) => {
      if (!editing) return;
      const loc = findStep(def, stepId);
      if (!loc) return;
      const { title } = stepLines(loc.step, names, def);
      const out = editing.apply([{ op: 'delete_step', stepId }], `Remove “${title}”`);
      if (!out.ok) return;
      const before = (laneSteps(def, loc.lane) ?? [])[loc.index - 1]?.id;
      onSelect(before ?? loc.lane.parentId ?? TRIGGER_NODE);
    },
    [def, editing, names, onSelect],
  );

  /** Delete, asking first when the step has others inside it (a branch's paths, a rejected path). */
  const remove = useCallback(
    (stepId: string) => {
      const loc = findStep(def, stepId);
      if (!loc || !editing) return;
      const inside = countSteps(childLanes(loc.step).flatMap((c) => c.steps));
      if (inside) setConfirm({ stepId, title: stepLines(loc.step, names, def).title, inside });
      else removeNow(stepId);
    },
    [def, editing, names, removeNow],
  );

  const setGoto = useCallback(
    (gotoId: string, targetId: string) => {
      if (!editing) return;
      const problem = gotoProblem(def, gotoId, targetId);
      if (problem) {
        toast.error(problem);
        return;
      }
      const out = editing.apply(
        [{ op: 'set_goto', stepId: gotoId, target: targetId, maxVisits: null }],
        'Change where it goes back to',
      );
      if (out.ok) onSelect(gotoId);
    },
    [def, editing, onSelect],
  );

  // ---- Dragging a step onto a "+" (or anywhere along an edge) ----

  const slots = useMemo(
    () =>
      graph.edges.flatMap((e) => {
        if (e.kind !== 'flow' || !e.point) return [];
        const geo = edgeGeometryFromLayout(e, layout, (id) => kinds.get(id) ?? 'step');
        return geo ? [{ edgeId: e.id, point: e.point, geo }] : [];
      }),
    [graph, layout, kinds],
  );

  /** The "+" a step dropped at this screen point lands on, with where it would go and why it can't. */
  const dropAt = useCallback(
    (client: Pt, stepId: string) => {
      const p = flow.screenToFlowPosition(client);
      const reach = DROP_REACH / flow.getZoom();
      let best: (typeof slots)[number] | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const s of slots) {
        const d = Math.min(distance(p, s.geo.slot), distanceToPolyline(p, s.geo.points));
        if (d <= reach && d < bestD) {
          best = s;
          bestD = d;
        }
      }
      const loc = findStep(def, stepId);
      if (!best || !loc) return null;
      const at = best.point;
      const sameLane = at.parentId === loc.lane.parentId && at.branchId === loc.lane.branchId;
      // Right above or below itself: it's already there.
      if (sameLane && (at.index === loc.index || at.index === loc.index + 1)) return null;
      const to: LaneRef & { index: number } = {
        parentId: at.parentId,
        branchId: at.branchId,
        index: sameLane && at.index > loc.index ? at.index - 1 : at.index,
      };
      return { edgeId: best.edgeId, to, problem: moveProblem(def, stepId, to) };
    },
    [def, flow, slots],
  );

  const onNodeDrag: OnNodeDrag<CanvasNode> = useCallback(
    (event, node) => {
      const point = clientPoint(event);
      const hit = point ? dropAt(point, node.id) : null;
      setDrop((prev) => {
        const next = hit ? { edgeId: hit.edgeId, ok: hit.problem === null } : null;
        return prev?.edgeId === next?.edgeId && prev?.ok === next?.ok ? prev : next;
      });
    },
    [dropAt],
  );

  const onNodeDragStop: OnNodeDrag<CanvasNode> = useCallback(
    (event, node) => {
      const point = clientPoint(event);
      const hit = point ? dropAt(point, node.id) : null;
      const from = layout.positions.get(node.id);
      setDrag(null);
      setDrop(null);
      if (!editing) return;
      if (!hit) {
        if (from && distance(from, node.position) > 60)
          toast.message('Drop a step on a + to move it there.');
        return;
      }
      if (hit.problem) {
        toast.error(MOVE_PROBLEMS[hit.problem]);
        return;
      }
      editing.apply([{ op: 'move_step', stepId: node.id, ...hit.to }], 'Move a step');
    },
    [dropAt, editing, layout],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.dragging && c.position)
          setDrag({ id: c.id, position: c.position });
        // Enter or Space on a focused node.
        else if (c.type === 'select' && c.selected) onSelect(c.id);
      }
    },
    [onSelect],
  );

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback(
    (_event, node) => {
      if (node.selectable) onSelect(node.id);
    },
    [onSelect],
  );

  // ---- A go-to's handle dragged onto a step ----

  const isValidConnection = useCallback(
    (c: Connection | CanvasEdge) => gotoProblem(def, c.source, c.target) === null,
    [def],
  );
  const onConnect = useCallback((c: Connection) => setGoto(c.source, c.target), [setGoto]);
  /** Dropped on a step's card rather than right on its edge: that step still counts. */
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, state) => {
      if (state.isValid || !state.fromNode) return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const el = document
        .elementFromPoint(point.clientX, point.clientY)
        ?.closest<HTMLElement>('.react-flow__node');
      const target = el?.dataset.id;
      if (target && target !== state.fromNode.id) setGoto(state.fromNode.id, target);
    },
    [setGoto],
  );

  // ---- Delete or Backspace on the selected step ----

  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          t.closest(
            'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]',
          ))
      )
        return;
      // Only from the canvas (or nowhere in particular), never from the rail.
      if (t && t !== document.body && !root.current?.contains(t)) return;
      if (!selectedId || !steps.has(selectedId)) return;
      e.preventDefault();
      remove(selectedId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editable, remove, selectedId, steps]);

  // ---- Opening, and keeping the selection in view ----

  /** The flow itself (under the phone's note), which the viewport fits. */
  const pane = useRef<HTMLDivElement>(null);

  const onInit = useCallback(
    (instance: ReactFlowInstance<CanvasNode, CanvasEdge>) => {
      const box = pane.current?.getBoundingClientRect();
      if (box?.width && box.height) {
        const at = selectedId ? layout.positions.get(selectedId) : undefined;
        const kind = selectedId ? kinds.get(selectedId) : undefined;
        const focus = at && kind ? { ...at, ...NODE_SIZE[kind] } : null;
        void instance.setViewport(initialViewport(layout, box, focus));
      }
      setViewportReady(true);
    },
    [kinds, layout, selectedId],
  );

  // A step picked elsewhere (Checks, the URL) that's off screen: bring it into view. Deliberately not on
  // layout changes, so an edit never pans the canvas.
  const layoutRef = useRef({ layout, kinds });
  useEffect(() => {
    layoutRef.current = { layout, kinds };
  }, [layout, kinds]);
  useEffect(() => {
    if (!viewportReady || !selectedId) return;
    const { layout: l, kinds: k } = layoutRef.current;
    const at = l.positions.get(selectedId);
    const kind = k.get(selectedId);
    const box = pane.current?.getBoundingClientRect();
    if (!at || !kind || !box) return;
    const size = NODE_SIZE[kind];
    const { x, y, zoom } = flow.getViewport();
    const left = at.x * zoom + x;
    const top = at.y * zoom + y;
    if (
      left >= 0 &&
      top >= 0 &&
      left + size.width * zoom <= box.width &&
      top + size.height * zoom <= box.height
    )
      return;
    void flow.setCenter(at.x + size.width / 2, at.y + size.height / 2, { zoom, duration: 200 });
  }, [flow, selectedId, viewportReady]);

  // Ready once the nodes are on screen: the time from the canvas's first render to the frame after its
  // nodes are in the page, placed where the viewport opens.
  useEffect(() => {
    if (renderMs !== null || !viewportReady) return;
    let frame = 0;
    const check = () => {
      if (!pane.current?.querySelector('.react-flow__node')) {
        frame = requestAnimationFrame(check);
        return;
      }
      frame = requestAnimationFrame(() => setRenderMs(Math.round(performance.now() - startedAt)));
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [renderMs, startedAt, viewportReady]);

  const ctx = useMemo<CanvasContextValue>(
    () => ({ def, editable, insert, moveTo: editing?.onMoveTo ?? noop, remove }),
    [def, editable, editing, insert, remove],
  );

  return (
    <CanvasProvider value={ctx}>
      <div
        ref={root}
        className={cn('wf-canvas flex h-full w-full flex-col', className)}
        role="region"
        aria-label="Workflow canvas"
        data-testid="workflow-canvas"
        data-ready={renderMs === null ? 'false' : 'true'}
        data-render-ms={renderMs ?? undefined}
        data-layout={shortHash(key)}
        data-view-only={editable ? 'false' : 'true'}
      >
        {phone ? (
          <Note
            icon={Eye}
            className="m-3 mb-0 flex-none bg-accent-soft text-accent-text [&>svg]:text-accent-text"
            testId="canvas-view-only"
          >
            View only on a phone. Edit in Steps or Describe.
          </Note>
        ) : null}
        <div ref={pane} className="relative min-h-0 flex-1">
          <ReactFlow<CanvasNode, CanvasEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onNodeClick={onNodeClick}
            onNodeDrag={editable ? onNodeDrag : undefined}
            onNodeDragStop={editable ? onNodeDragStop : undefined}
            onConnect={editable ? onConnect : undefined}
            onConnectEnd={editable ? onConnectEnd : undefined}
            isValidConnection={isValidConnection}
            onInit={onInit}
            nodesDraggable={editable}
            nodesConnectable={editable}
            elementsSelectable
            nodesFocusable
            edgesFocusable={false}
            selectNodesOnDrag={false}
            nodeDragThreshold={4}
            deleteKeyCode={null}
            selectionKeyCode={null}
            multiSelectionKeyCode={null}
            zoomOnDoubleClick={false}
            panOnScroll
            onlyRenderVisibleElements
            minZoom={0.1}
            maxZoom={1.5}
            connectionRadius={28}
            attributionPosition="top-right"
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={18}
              size={1.2}
              color="var(--border-strong)"
              bgColor="var(--bg)"
            />
            <GotoEdges lines={gotoLines} />
            {minimap ? (
              <MiniMap<CanvasNode>
                pannable
                zoomable
                ariaLabel="Minimap"
                position="bottom-right"
                nodeColor={(n) => (n.selected ? 'var(--accent)' : 'var(--card-3)')}
                nodeStrokeColor="transparent"
                nodeBorderRadius={3}
                bgColor="var(--card)"
                maskColor="color-mix(in oklab, var(--bg) 62%, transparent)"
                maskStrokeColor="var(--accent)"
                maskStrokeWidth={1.5}
                style={{ width: 168, height: 128 }}
              />
            ) : null}
            <Controls minimap={minimap} onMinimap={() => setMinimap((v) => !v)} />
          </ReactFlow>
        </div>
        <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
          <DialogContent
            title="Delete this step?"
            description={
              confirm
                ? `“${confirm.title}” and the ${confirm.inside} ${confirm.inside === 1 ? 'step' : 'steps'} in its paths are removed. Undo brings them back.`
                : undefined
            }
          >
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                data-testid="canvas-delete-confirm"
                onClick={() => {
                  if (confirm) removeNow(confirm.stepId);
                  setConfirm(null);
                }}
              >
                Delete
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </CanvasProvider>
  );
}

function ControlButton({
  label,
  testId,
  pressed,
  onClick,
  children,
}: {
  label: string;
  testId: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex h-[34px] w-[34px] items-center justify-center text-text-2 hover:bg-card-2 hover:text-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring',
        pressed && 'text-accent-text',
      )}
    >
      {children}
    </button>
  );
}

/** Zoom out, the zoom level, zoom in, fit, and the minimap (the design's control bar). */
function Controls({ minimap, onMinimap }: { minimap: boolean; onMinimap: () => void }) {
  const { zoomIn, zoomOut, getNodes, setViewport } = useReactFlow<CanvasNode, CanvasEdge>();
  const zoom = useStore((s) => s.transform[2]);
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  /**
   * Fits every node, drawn or not. xyflow's own fit counts only the nodes it has measured, and with only the
   * visible ones drawn that would fit just what's already on screen.
   */
  const fitView = ({ padding, maxZoom }: { padding: number; maxZoom: number }) => {
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const n of getNodes()) {
      left = Math.min(left, n.position.x);
      top = Math.min(top, n.position.y);
      right = Math.max(right, n.position.x + (n.width ?? 0));
      bottom = Math.max(bottom, n.position.y + (n.height ?? 0));
    }
    if (!Number.isFinite(left) || !paneWidth || !paneHeight) return;
    const [w, h] = [right - left, bottom - top];
    const z = Math.max(
      0.1, // the canvas's minZoom
      Math.min(maxZoom, paneWidth / (w * (1 + 2 * padding)), paneHeight / (h * (1 + 2 * padding))),
    );
    void setViewport({
      x: Math.round((paneWidth - w * z) / 2 - left * z),
      y: Math.round((paneHeight - h * z) / 2 - top * z),
      zoom: z,
    });
  };
  const icon = 'h-4 w-4';
  return (
    <Panel position="bottom-left">
      <div className="flex items-center overflow-hidden rounded-[10px] border border-border bg-card shadow-2">
        <ControlButton label="Zoom out" testId="canvas-zoom-out" onClick={() => void zoomOut()}>
          <Minus className={icon} strokeWidth={1.75} />
        </ControlButton>
        <span
          className="flex h-[34px] min-w-[52px] items-center justify-center border-x border-border text-[12.5px] font-semibold tabular-nums text-text"
          data-testid="canvas-zoom-level"
        >
          {Math.round(zoom * 100)}%
        </span>
        <ControlButton label="Zoom in" testId="canvas-zoom-in" onClick={() => void zoomIn()}>
          <Plus className={icon} strokeWidth={1.75} />
        </ControlButton>
        <span aria-hidden className="h-[34px] w-px bg-border" />
        <ControlButton label="Fit to screen" testId="canvas-fit" onClick={() => void fitView(FIT)}>
          <Maximize className={icon} strokeWidth={1.75} />
        </ControlButton>
        <ControlButton
          label={minimap ? 'Hide the minimap' : 'Show the minimap'}
          testId="canvas-minimap"
          pressed={minimap}
          onClick={onMinimap}
        >
          <MapIcon className={icon} strokeWidth={1.75} />
        </ControlButton>
      </div>
    </Panel>
  );
}
