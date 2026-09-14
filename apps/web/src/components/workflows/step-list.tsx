'use client';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  canMove,
  childLanes,
  countSteps,
  describeTrigger,
  findStep,
  insertionPoints,
  laneSteps,
  type InsertionPoint,
  type LaneRef,
  type Step,
  type WorkflowCatalogs,
  type WorkflowDefinition,
  type WorkflowIssue,
  type WorkflowNames,
  type WorkflowOp,
} from '@hfos/core';
import { ChevronDown, ChevronRight, GripVertical, Merge } from 'lucide-react';
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useMatches } from '@/lib/use-media';
import type { ApplyOutcome } from '@/lib/workflows/use-draft';
import { newStep, stepLines, stepTone, type NewStepKind } from '@/lib/workflows/steps';
import { cn } from '@/lib/utils';
import { AddStepMenu } from './add-step-menu';
import { KindTile, laneColor, stepIcon, triggerIconOf } from './chips';

/** A mark on one step for read-only views: where a run is, what a diff changes, a note. */
export interface StepOverlay {
  readonly status?:
    | 'done'
    | 'running'
    | 'waiting'
    | 'skipped'
    | 'failed'
    | 'not_reached'
    | 'added'
    | 'changed'
    | 'removed';
  /** A short line under the card ("Sent 10:41 AM", "Waiting until 8:03 AM"). */
  readonly note?: string;
}

/** Editing hooks; leave them out for a read-only list. */
export interface StepListEditing {
  readonly apply: (ops: readonly WorkflowOp[], label: string) => ApplyOutcome;
  /** For new steps' defaults (the first stage, tag, calendar…). */
  readonly catalogs: WorkflowCatalogs;
  /** This workflow, so "Start another workflow" doesn't pick itself. */
  readonly workflowId: string | null;
  /** Opens "Move to…" for a step. */
  readonly onMoveTo: (stepId: string) => void;
  /** Drag by the handle (off on touch screens either way). */
  readonly drag?: boolean;
}

export interface StepListProps {
  readonly definition: WorkflowDefinition;
  /** Names for ids (team, stages, tags…): any of the workflow catalogs. */
  readonly names: WorkflowNames;
  /** Checks, for the red and amber dots on steps. */
  readonly issues?: readonly WorkflowIssue[];
  /** A step id, or 'trigger'. */
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string) => void;
  readonly editing?: StepListEditing;
  readonly overlays?: Readonly<Record<string, StepOverlay>>;
  /** Phone layout: bigger rows with a chevron, no handles. */
  readonly phone?: boolean;
  readonly className?: string;
  readonly testId?: string;
}

export const TRIGGER_ITEM = 'trigger';

interface ListContext {
  readonly def: WorkflowDefinition;
  readonly names: WorkflowNames;
  readonly flags: ReadonlyMap<string, WorkflowIssue>;
  readonly triggerFlag: WorkflowIssue | null;
  readonly selectedId: string | null;
  readonly focusId: string;
  readonly onSelect: (id: string) => void;
  readonly editing: StepListEditing | null;
  readonly dragOn: boolean;
  readonly overlays: Readonly<Record<string, StepOverlay>>;
  readonly phone: boolean;
  readonly points: ReadonlyMap<string, InsertionPoint>;
  readonly collapsed: ReadonlySet<string>;
  readonly toggle: (key: string) => void;
  readonly insert: (at: InsertionPoint, kind: NewStepKind, label: string) => void;
}

const Ctx = createContext<ListContext | null>(null);
const useList = () => useContext(Ctx)!;

const laneKey = (lane: LaneRef) => `${lane.parentId ?? 'root'}|${lane.branchId ?? ''}`;
const pointKey = (lane: LaneRef, index: number) => `${laneKey(lane)}|${index}`;
const sameLane = (a: LaneRef, b: LaneRef) => a.parentId === b.parentId && a.branchId === b.branchId;
/** Collapsed keys: a whole branch step (`step:id`) or one of its paths (`lane:parent|branch`). */
const stepKey = (id: string) => `step:${id}`;
const pathKey = (lane: LaneRef) => `lane:${laneKey(lane)}`;

interface DragData {
  readonly type: 'step' | 'lane';
  readonly lane: LaneRef;
  readonly index: number;
  readonly depth: number;
}

/** Prefers what's under the pointer, deepest lane first (and a step over its lane), else the closest. */
const deepestFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return closestCenter(args);
  const rank = (id: string | number) => {
    const d = args.droppableContainers.find((c) => c.id === id)?.data.current as
      DragData | undefined;
    return d ? d.depth * 2 + (d.type === 'step' ? 1 : 0) : -1;
  };
  return [...hits].sort((a, b) => rank(b.id) - rank(a.id));
};

/** The ids a keyboard walks, top to bottom, skipping collapsed paths. */
function visibleIds(def: WorkflowDefinition, collapsed: ReadonlySet<string>): string[] {
  const out: string[] = [TRIGGER_ITEM];
  const walk = (steps: readonly Step[]) => {
    for (const s of steps) {
      out.push(s.id);
      if (collapsed.has(stepKey(s.id))) continue;
      for (const c of childLanes(s)) {
        if (collapsed.has(pathKey({ parentId: s.id, branchId: c.branchId }))) continue;
        walk(c.steps);
      }
    }
  };
  walk(def.steps);
  return out;
}

/**
 * The Steps editor: the trigger, then the steps with branches as nested paths, "+" slots between steps,
 * drag by the handle (one sortable list per path; a drop is one `move_step`), a tree for the keyboard
 * (arrows, Alt + ↑/↓ to move within a path) and "Move to…". Without `editing` it is a read-only list with
 * optional overlays, for run detail, history, diffs and template previews.
 */
export function StepList({
  definition: def,
  names,
  issues = [],
  selectedId = null,
  onSelect = () => {},
  editing,
  overlays = {},
  phone = false,
  className,
  testId = 'step-list',
}: StepListProps) {
  const dndId = useId();
  const tree = useRef<HTMLDivElement>(null);
  const coarse = useMatches('(pointer: coarse)');
  const dragOn = !!editing && editing.drag !== false && !coarse && !phone;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 4 } }));

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
  const points = useMemo(() => {
    const m = new Map<string, InsertionPoint>();
    if (editing) for (const p of insertionPoints(def)) m.set(pointKey(p, p.index), p);
    return m;
  }, [def, editing]);

  const ids = useMemo(() => visibleIds(def, collapsed), [def, collapsed]);
  const focusId = selectedId && ids.includes(selectedId) ? selectedId : TRIGGER_ITEM;

  const toggle = useCallback(
    (key: string) =>
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

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

  const focusItem = (id: string | undefined) => {
    if (!id) return;
    const el = tree.current?.querySelector<HTMLElement>(
      `[data-tree-id="${window.CSS.escape(id)}"]`,
    );
    el?.focus();
    onSelect(id);
  };

  const moveBy = (id: string, delta: -1 | 1) => {
    if (!editing) return;
    const loc = findStep(def, id);
    if (!loc) return;
    const to = { ...loc.lane, index: loc.index + delta };
    if (to.index < 0 || !canMove(def, id, to)) {
      toast.message(
        delta < 0 ? 'It’s already first in its path.' : 'It can’t go further down here.',
      );
      return;
    }
    editing.apply([{ op: 'move_step', stepId: id, ...to }], delta < 0 ? 'Move up' : 'Move down');
    requestAnimationFrame(() =>
      tree.current
        ?.querySelector<HTMLElement>(`[data-tree-id="${window.CSS.escape(id)}"]`)
        ?.focus(),
    );
  };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-id]');
    if (!item || e.target !== item) return;
    const id = item.dataset.treeId!;
    const i = ids.indexOf(id);
    const step = id === TRIGGER_ITEM ? null : findStep(def, id);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (e.altKey && step) moveBy(id, 1);
        else focusItem(ids[i + 1]);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (e.altKey && step) moveBy(id, -1);
        else focusItem(ids[i - 1]);
        break;
      case 'Home':
        e.preventDefault();
        focusItem(ids[0]);
        break;
      case 'End':
        e.preventDefault();
        focusItem(ids.at(-1));
        break;
      case 'ArrowRight':
        if (step && childLanes(step.step).length) {
          e.preventDefault();
          if (collapsed.has(stepKey(id))) toggle(stepKey(id));
          else focusItem(ids[i + 1]);
        }
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (step && childLanes(step.step).length && !collapsed.has(stepKey(id)))
          toggle(stepKey(id));
        else if (step?.lane.parentId) focusItem(step.lane.parentId);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        onSelect(id);
        break;
    }
  }

  function onDragStart(e: DragStartEvent) {
    setDragging(String(e.active.id));
  }

  function onDragEnd(e: DragEndEvent) {
    setDragging(null);
    const { active, over } = e;
    if (!over || !editing || over.id === active.id) return;
    const stepId = String(active.id);
    const loc = findStep(def, stepId);
    const data = over.data.current as DragData | undefined;
    if (!loc || !data) return;
    let index: number;
    if (data.type === 'lane') {
      const steps = laneSteps(def, data.lane) ?? [];
      const rest = sameLane(loc.lane, data.lane) ? steps.filter((s) => s.id !== stepId) : steps;
      index =
        rest.at(-1)?.type === 'goto' || rest.at(-1)?.type === 'end' ? rest.length - 1 : rest.length;
    } else index = data.index;
    const to = { ...data.lane, index: Math.max(0, index) };
    if (sameLane(loc.lane, to) && to.index === loc.index) return;
    if (!canMove(def, stepId, to)) {
      toast.error('That step can’t go there. Try “Move to…” to see where it can.');
      return;
    }
    editing.apply([{ op: 'move_step', stepId, ...to }], 'Move a step');
  }

  const context: ListContext = {
    def,
    names,
    flags,
    triggerFlag,
    selectedId,
    focusId,
    onSelect,
    editing: editing ?? null,
    dragOn,
    overlays,
    phone,
    points,
    collapsed,
    toggle,
    insert,
  };
  const rootEnds = ['end', 'goto'].includes(def.steps.at(-1)?.type ?? '');
  const active = dragging ? findStep(def, dragging)?.step : undefined;

  const body = (
    <div
      ref={tree}
      role="tree"
      aria-label="Workflow steps"
      aria-readonly={!editing || undefined}
      onKeyDown={onKeyDown}
      data-testid={testId}
      className={cn('flex flex-col items-center', className)}
    >
      <TriggerCard />
      <Lane lane={{ parentId: null, branchId: null }} steps={def.steps} depth={0} />
      {rootEnds ? null : (
        <>
          {def.steps.length ? null : <Line />}
          <EndPill />
        </>
      )}
    </div>
  );

  return (
    <Ctx.Provider value={context}>
      {dragOn ? (
        <DndContext
          id={dndId}
          sensors={sensors}
          collisionDetection={deepestFirst}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setDragging(null)}
        >
          {body}
          <DragOverlay dropAnimation={null}>
            {active ? (
              <div className="w-[300px] rotate-[-1.2deg] shadow-3">
                <CardFace step={active} selected={false} handle={null} depth={0} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        body
      )}
    </Ctx.Provider>
  );
}

// ---- Pieces ----

function Line({ grow, className }: { grow?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'block w-0.5 flex-none bg-border-strong',
        grow ? 'min-h-3.5 flex-1' : 'h-4',
        className,
      )}
    />
  );
}

/** A connector between steps, with the "+" when a step can go there. */
function Slot({ lane, index, grow }: { lane: LaneRef; index: number; grow?: boolean }) {
  const { points, def, insert, phone } = useList();
  const at = points.get(pointKey(lane, index));
  if (!at) return grow ? <Line grow /> : <Line className={phone ? 'h-3' : 'h-[26px]'} />;
  return (
    <div
      className={cn(
        'relative flex w-full flex-none flex-col items-center justify-center',
        grow ? 'min-h-[26px] flex-1' : 'h-[26px]',
      )}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-border-strong"
      />
      <AddStepMenu def={def} at={at} onPick={(kind, label) => insert(at, kind, label)} />
    </div>
  );
}

function Lane({ lane, steps, depth }: { lane: LaneRef; steps: readonly Step[]; depth: number }) {
  const { dragOn } = useList();
  const droppable = useDroppable({
    id: `lane:${laneKey(lane)}`,
    data: { type: 'lane', lane, index: steps.length, depth } satisfies DragData,
    disabled: !dragOn,
  });
  const inBranch = lane.parentId !== null;
  return (
    <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      <div
        ref={droppable.setNodeRef}
        className={cn(
          'flex w-full flex-col items-center',
          inBranch && 'flex-1',
          droppable.isOver && dragOn && 'rounded-[10px] bg-accent-soft/60',
        )}
        data-lane={laneKey(lane)}
      >
        <Slot lane={lane} index={0} />
        {steps.map((s, i) => (
          <Fragment key={s.id}>
            <StepNode step={s} lane={lane} index={i} depth={depth} />
            {s.type === 'goto' || s.type === 'end' ? (
              inBranch ? (
                <span className="flex-1" />
              ) : null
            ) : (
              <Slot lane={lane} index={i + 1} grow={inBranch && i === steps.length - 1} />
            )}
          </Fragment>
        ))}
        {!steps.length && inBranch ? (
          <span className="mb-0.5 text-xs text-text-3">No steps yet</span>
        ) : null}
        {!steps.length && inBranch ? <Line grow /> : null}
      </div>
    </SortableContext>
  );
}

function TriggerCard() {
  const { def, names, selectedId, focusId, onSelect, phone, triggerFlag } = useList();
  const Icon = triggerIconOf(def.trigger);
  const selected = selectedId === TRIGGER_ITEM;
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      tabIndex={focusId === TRIGGER_ITEM ? 0 : -1}
      data-tree-id={TRIGGER_ITEM}
      data-testid="step-trigger"
      onClick={() => onSelect(TRIGGER_ITEM)}
      className={cn(
        'relative flex w-full cursor-pointer items-center gap-[9px] rounded-[10px] border bg-card px-2.5 py-2 shadow-1 transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        phone ? 'min-h-[58px]' : 'min-h-[54px] max-w-[372px]',
        selected
          ? 'border-accent shadow-[0_0_0_1px_var(--accent),var(--shadow-1)]'
          : 'border-[color-mix(in_oklab,var(--success)_35%,var(--border))] hover:border-[color-mix(in_oklab,var(--success)_55%,var(--border))]',
      )}
    >
      <KindTile tone="trig" icon={Icon} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block font-semibold leading-[1.3]',
            phone ? 'text-[14.5px]' : 'text-[13.5px]',
          )}
        >
          {describeTrigger(def.trigger, names)}
        </span>
      </span>
      {phone ? (
        <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
      ) : (
        <span className="self-start pt-0.5 text-[11px] font-semibold uppercase text-success-text">
          When
        </span>
      )}
      {triggerFlag ? (
        <span
          className="absolute -right-[5px] -top-[5px] h-3 w-3 rounded-full border-2 border-card"
          style={{
            background: triggerFlag.severity === 'error' ? 'var(--danger)' : 'var(--warning)',
          }}
          title={triggerFlag.severity === 'error' ? 'Needs a fix' : 'Check this'}
          data-testid="step-flag"
        >
          <span className="sr-only">{triggerFlag.message}</span>
        </span>
      ) : null}
    </div>
  );
}

function EndPill() {
  return (
    <span className="inline-flex h-[34px] items-center gap-1.5 rounded-full border border-border bg-card pl-[5px] pr-3 text-[12.5px] font-medium text-text-2 shadow-1">
      <KindTile tone="end" icon={stepIcon({ id: 's_end00000', type: 'end' })} size="sm" />
      End
    </span>
  );
}

const OVERLAY_TAGS: Partial<
  Record<NonNullable<StepOverlay['status']>, { label: string; cls: string }>
> = {
  added: { label: 'New', cls: 'bg-success text-on-solid' },
  changed: { label: 'Changed', cls: 'bg-warning text-on-solid' },
  removed: { label: 'Removed', cls: 'bg-danger text-on-solid' },
  failed: { label: 'Failed', cls: 'bg-danger text-on-solid' },
};

function overlayClass(status: StepOverlay['status']): string {
  switch (status) {
    case 'done':
      return 'border-[color-mix(in_oklab,var(--success)_45%,var(--border))]';
    case 'running':
    case 'waiting':
      return 'border-accent';
    case 'failed':
      return 'border-danger shadow-[0_0_0_1px_var(--danger)]';
    case 'skipped':
      return 'opacity-70';
    case 'not_reached':
      return 'border-dashed opacity-50 shadow-none';
    case 'added':
      return 'border-[color-mix(in_oklab,var(--success)_60%,var(--border))] shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_16%,transparent)]';
    case 'changed':
      return 'border-[color-mix(in_oklab,var(--warning)_60%,var(--border))]';
    case 'removed':
      return 'opacity-60 [&_.step-title]:line-through';
    default:
      return '';
  }
}

/** A step card's face (also the drag preview). */
function CardFace({
  step,
  selected,
  handle,
  depth,
  tail,
}: {
  step: Step;
  selected: boolean;
  handle: ReactNode;
  depth: number;
  tail?: ReactNode;
}) {
  const { def, names, flags, overlays, phone } = useList();
  const { title, detail } = stepLines(step, names, def);
  const flag = flags.get(step.id);
  const overlay = overlays[step.id];
  const tag = overlay?.status ? OVERLAY_TAGS[overlay.status] : undefined;
  return (
    <div
      className={cn(
        'relative flex w-full items-center gap-[9px] rounded-[10px] border bg-card py-2 pr-2.5 shadow-1 transition-colors',
        handle ? 'pl-1' : 'pl-2.5',
        phone ? 'min-h-[58px]' : 'min-h-[54px]',
        selected
          ? 'border-accent shadow-[0_0_0_1px_var(--accent),var(--shadow-1)]'
          : 'border-border group-hover/card:border-border-strong',
        overlayClass(overlay?.status),
      )}
    >
      {tag ? (
        <span
          className={cn(
            'absolute -top-[9px] left-3 inline-flex h-[18px] items-center rounded-[5px] px-1.5 text-[10.5px] font-semibold uppercase',
            tag.cls,
          )}
        >
          {tag.label}
        </span>
      ) : null}
      {handle}
      <KindTile tone={stepTone(step)} icon={stepIcon(step)} size={depth > 0 ? 'sm' : 'md'} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'step-title block font-semibold leading-[1.3]',
            phone ? 'text-[14.5px]' : 'text-[13.5px]',
          )}
        >
          {title}
        </span>
        {detail ? (
          <span
            className={cn(
              'line-clamp-2 block break-words text-text-2',
              phone ? 'text-[13px]' : 'text-xs',
            )}
          >
            {detail}
          </span>
        ) : null}
        {overlay?.note ? (
          <span className="mt-0.5 block text-xs text-text-3" data-testid="step-note">
            {overlay.note}
          </span>
        ) : null}
      </span>
      {tail}
      {phone ? <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} /> : null}
      {flag ? (
        <span
          className="absolute -right-[5px] -top-[5px] h-3 w-3 rounded-full border-2 border-card"
          style={{ background: flag.severity === 'error' ? 'var(--danger)' : 'var(--warning)' }}
          title={flag.severity === 'error' ? 'Needs a fix' : 'Check this'}
          data-testid="step-flag"
        >
          <span className="sr-only">{flag.message}</span>
        </span>
      ) : null}
    </div>
  );
}

function StepNode({
  step,
  lane,
  index,
  depth,
}: {
  step: Step;
  lane: LaneRef;
  index: number;
  depth: number;
}) {
  const { selectedId, focusId, onSelect, dragOn, collapsed, toggle, phone } = useList();
  const sortable = useSortable({
    id: step.id,
    data: { type: 'step', lane, index, depth } satisfies DragData,
    disabled: !dragOn,
  });
  const selected = selectedId === step.id;
  const hasLanes = step.type === 'branch';
  const open = !collapsed.has(stepKey(step.id));
  const handle = dragOn ? (
    <button
      type="button"
      ref={sortable.setActivatorNodeRef}
      {...sortable.listeners}
      tabIndex={-1}
      aria-label="Drag to move"
      title="Drag to move, or select it and press Alt + ↑ or ↓"
      onClick={(e) => e.stopPropagation()}
      className="flex h-8 w-5 flex-none cursor-grab items-center justify-center text-text-3 opacity-55 hover:opacity-100 active:cursor-grabbing"
      data-testid="drag-handle"
    >
      <GripVertical className="h-3.5 w-3.5" strokeWidth={1.75} />
    </button>
  ) : null;

  const card =
    step.type === 'end' ? (
      <span className="inline-flex h-[34px] items-center gap-1.5 rounded-full border border-border bg-card pl-[5px] pr-3 text-[12.5px] font-medium text-text-2 shadow-1">
        {handle}
        <KindTile tone="end" icon={stepIcon(step)} size="sm" />
        End
      </span>
    ) : (
      <CardFace
        step={step}
        selected={selected}
        handle={handle}
        depth={depth}
        tail={
          hasLanes ? (
            <button
              type="button"
              aria-label={open ? 'Collapse the paths' : 'Show the paths'}
              onClick={(e) => {
                e.stopPropagation();
                toggle(stepKey(step.id));
              }}
              className="flex h-7 w-7 flex-none items-center justify-center rounded-control text-text-3 hover:bg-card-2 hover:text-text"
            >
              {open ? (
                <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
              ) : (
                <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
              )}
            </button>
          ) : null
        }
      />
    );

  const item = (
    <div
      role="treeitem"
      aria-level={depth + 2}
      aria-selected={selected}
      aria-expanded={hasLanes ? open : undefined}
      tabIndex={focusId === step.id ? 0 : -1}
      data-tree-id={step.id}
      data-testid={`step-${step.id}`}
      onClick={() => onSelect(step.id)}
      className={cn(
        'group/card flex w-full cursor-pointer justify-center rounded-[10px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        step.type === 'end' && 'w-auto',
      )}
    >
      {card}
    </div>
  );

  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className={cn(
        'flex w-full flex-col items-center',
        depth === 0 && !hasLanes && !phone && 'max-w-[372px]',
        sortable.isDragging && 'opacity-40',
      )}
    >
      {hasLanes ? (
        <BranchBlock step={step} depth={depth} open={open}>
          {item}
        </BranchBlock>
      ) : (
        item
      )}
      {step.type === 'approval' ? <RejectedLane step={step} depth={depth} /> : null}
    </div>
  );
}

/** A branch step: its card, then its paths side by side (or stacked when narrow), then where they join. */
function BranchBlock({
  step,
  depth,
  open,
  children,
}: {
  step: Extract<Step, { type: 'branch' }>;
  depth: number;
  open: boolean;
  children: ReactNode;
}) {
  const { collapsed, toggle } = useList();
  const hidden = countSteps(step.branches.flatMap((b) => b.steps));
  return (
    <div className="@container w-full rounded-[14px] border-[1.5px] border-dashed border-[color-mix(in_oklab,#0e7490_40%,var(--border-strong))] bg-[color-mix(in_oklab,#0e7490_6%,transparent)] px-2.5 py-3">
      <div className="mx-auto flex w-full max-w-[372px] flex-col items-center">{children}</div>
      {open ? (
        <>
          <Line className="mx-auto" />
          <div className="flex flex-col gap-2 @[560px]:flex-row @[560px]:gap-3">
            {step.branches.map((b, i) => {
              const lane = { parentId: step.id, branchId: b.id };
              const shut = collapsed.has(pathKey(lane));
              const color = laneColor(i, b.condition === null && step.mode !== 'ai');
              const first = i === 0;
              const last = i === step.branches.length - 1;
              return (
                <div
                  key={b.id}
                  className={cn(
                    'relative flex min-w-0 flex-col items-stretch @[560px]:items-center',
                    shut
                      ? '@[560px]:w-[150px] @[560px]:flex-none'
                      : '@[560px]:min-w-[200px] @[560px]:flex-1',
                  )}
                  data-testid={`path-${b.id}`}
                >
                  <span
                    aria-hidden
                    className="absolute top-0 hidden h-0.5 bg-border-strong @[560px]:block"
                    style={{ left: first ? '50%' : -6, right: last ? '50%' : -6 }}
                  />
                  <span aria-hidden className="hidden @[560px]:block">
                    <Line />
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(pathKey(lane))}
                    aria-expanded={!shut}
                    className="flex min-h-11 w-full items-center gap-2 rounded-[10px] border border-border bg-card px-3 text-left @[560px]:h-[26px] @[560px]:min-h-0 @[560px]:w-auto @[560px]:max-w-full @[560px]:rounded-full @[560px]:px-2.5"
                  >
                    <span
                      aria-hidden
                      className="h-2 w-2 flex-none rounded-full"
                      style={{ background: color }}
                    />
                    <span className="min-w-0 truncate text-[14px] font-semibold @[560px]:text-[12.5px]">
                      {b.name}
                    </span>
                    <span className="text-xs text-text-3 @[560px]:hidden">
                      {countSteps(b.steps)} {countSteps(b.steps) === 1 ? 'step' : 'steps'}
                    </span>
                    <span className="ml-auto text-text-3 @[560px]:ml-0">
                      {shut ? (
                        <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                      )}
                    </span>
                  </button>
                  {shut ? (
                    <>
                      <span aria-hidden className="hidden @[560px]:block">
                        <Line />
                      </span>
                      <div className="hidden rounded-[10px] border border-dashed border-border-strong bg-card px-2.5 py-2 text-center text-xs text-text-2 @[560px]:block">
                        <strong className="block font-semibold text-text">
                          {countSteps(b.steps)} {countSteps(b.steps) === 1 ? 'step' : 'steps'}{' '}
                          hidden
                        </strong>
                      </div>
                      <span aria-hidden className="hidden flex-1 @[560px]:flex">
                        <Line grow className="mx-auto" />
                      </span>
                    </>
                  ) : (
                    <div
                      className="ml-3 mt-1.5 flex flex-1 flex-col border-l-2 pl-3.5 @[560px]:ml-0 @[560px]:mt-0 @[560px]:w-full @[560px]:border-l-0 @[560px]:pl-0"
                      style={{ borderColor: color }}
                    >
                      <Lane lane={lane} steps={b.steps} depth={depth + 1} />
                    </div>
                  )}
                  <span
                    aria-hidden
                    className="absolute bottom-0 hidden h-0.5 bg-border-strong @[560px]:block"
                    style={{ left: first ? '50%' : -6, right: last ? '50%' : -6 }}
                  />
                </div>
              );
            })}
          </div>
          <div className="flex flex-col items-center">
            <Line className="h-[22px]" />
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-text-3">
              <Merge className="h-3.5 w-3.5" strokeWidth={1.5} />
              The paths join here
            </span>
          </div>
        </>
      ) : (
        <p className="mt-2 text-center text-xs text-text-3">
          {step.branches.length} paths · {hidden} {hidden === 1 ? 'step' : 'steps'} hidden
        </p>
      )}
    </div>
  );
}

/** An approval's "If it's rejected" path, as a dashed box under the card. */
function RejectedLane({
  step,
  depth,
}: {
  step: Extract<Step, { type: 'approval' }>;
  depth: number;
}) {
  const { collapsed, toggle } = useList();
  const lane = { parentId: step.id, branchId: 'rejected' };
  const shut = collapsed.has(pathKey(lane));
  const n = countSteps(step.rejected.steps);
  return (
    <div className="ml-[26px] mt-1.5 w-[calc(100%-26px)] rounded-[10px] border border-dashed border-border-strong bg-card-2 p-2">
      <button
        type="button"
        onClick={() => toggle(pathKey(lane))}
        aria-expanded={!shut}
        className="flex w-full items-center gap-1.5 rounded-control px-1 py-0.5 text-left text-xs text-text-2"
        data-testid={`rejected-${step.id}`}
      >
        {shut ? (
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
        )}
        If it’s rejected · {n} {n === 1 ? 'step' : 'steps'}, then the run ends
      </button>
      {shut ? null : (
        <div className="flex flex-col items-center">
          <Lane lane={lane} steps={step.rejected.steps} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}
