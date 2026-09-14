'use client';
import type { Step, Trigger, WorkflowIssue } from '@hfos/core';
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import { CircleStop, CornerDownRight, MoreHorizontal, Trash2 } from 'lucide-react';
import { memo } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { stepTone } from '@/lib/workflows/steps';
import { cn } from '@/lib/utils';
import { KindTile, stepIcon, triggerIconOf } from '../chips';
import type { StepOverlay } from '../step-list';
import { useCanvas } from './context';
import type { GraphNode, GraphNodeKind } from './graph';

export interface CanvasNodeData extends Record<string, unknown> {
  readonly node: GraphNode;
  readonly step: Step | null;
  readonly trigger: Trigger | null;
  readonly title: string;
  readonly detail: string | null;
  /** The worst Checks item about it, for the red or amber dot Steps shows too. */
  readonly flag: WorkflowIssue | null;
  readonly overlay: StepOverlay | null;
}

export type CanvasNode = Node<CanvasNodeData, GraphNodeKind>;

const CARD =
  'relative flex h-full w-full items-center rounded-[10px] border bg-card shadow-1 transition-[border-color,box-shadow]';
const SELECTED = 'border-accent shadow-[0_0_0_1px_var(--accent),var(--shadow-2)]';

const OVERLAY_TAGS: Partial<
  Record<NonNullable<StepOverlay['status']>, { label: string; cls: string }>
> = {
  added: { label: 'New', cls: 'bg-success text-on-solid' },
  changed: { label: 'Changed', cls: 'bg-warning text-on-solid' },
  removed: { label: 'Removed', cls: 'bg-danger text-on-solid' },
  failed: { label: 'Failed', cls: 'bg-danger text-on-solid' },
};

/** The same marks the step list puts on a card for run detail, diffs and history. */
function overlayClass(status: StepOverlay['status'] | undefined): string {
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

function Overlay({ overlay }: { overlay: StepOverlay | null }) {
  if (!overlay) return null;
  const tag = overlay.status ? OVERLAY_TAGS[overlay.status] : undefined;
  return (
    <>
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
      {overlay.note ? (
        <span
          className="absolute left-1 top-full mt-1 max-w-full truncate text-[11px] text-text-3"
          data-testid="step-note"
        >
          {overlay.note}
        </span>
      ) : null}
    </>
  );
}

function Flag({ flag }: { flag: WorkflowIssue | null }) {
  if (!flag) return null;
  return (
    <span
      className="absolute -right-[5px] -top-[5px] h-3 w-3 rounded-full border-2 border-card"
      style={{ background: flag.severity === 'error' ? 'var(--danger)' : 'var(--warning)' }}
      title={flag.severity === 'error' ? 'Needs a fix' : 'Check this'}
      data-testid="step-flag"
    >
      <span className="sr-only">{flag.message}</span>
    </span>
  );
}

/** Where edges meet a node: the top (in) and bottom (out), drawn as small dots like the design's. */
function Anchors({ top = true, bottom = true, dots = true }) {
  const cls = cn('wf-hd', dots && 'wf-dot');
  return (
    <>
      {top ? (
        <Handle
          type="target"
          position={Position.Top}
          id="in"
          isConnectable={false}
          className={cls}
        />
      ) : null}
      {bottom ? (
        <Handle
          type="source"
          position={Position.Bottom}
          id="out"
          isConnectable={false}
          className={cls}
        />
      ) : null}
    </>
  );
}

/** Where a go-to's dashed edge comes back in. A go-to dragged here from its handle goes back to this step. */
function GotoTarget() {
  const { editable } = useCanvas();
  return (
    <Handle
      type="target"
      position={Position.Right}
      id="goto-in"
      isConnectable={editable}
      className="wf-hd"
    />
  );
}

/** The node's "…": Move to… (the same dialog as Steps) and Delete. */
function NodeMenu({ stepId, title, shown }: { stepId: string; title: string; shown: boolean }) {
  const { moveTo, remove } = useCanvas();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Move or delete “${title}”`}
          title="Move or delete"
          data-testid={`node-menu-${stepId}`}
          className={cn(
            'nodrag nopan flex h-6 w-6 flex-none items-center justify-center rounded-control text-text-3 transition-opacity hover:bg-card-2 hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring group-hover/node:opacity-100 data-[state=open]:opacity-100',
            shown ? 'opacity-100' : 'opacity-0',
          )}
        >
          <MoreHorizontal className="h-4 w-4" strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem onSelect={() => moveTo(stepId)} data-testid="node-move">
          <CornerDownRight className="h-4 w-4" strokeWidth={1.5} />
          Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem danger onSelect={() => remove(stepId)} data-testid="node-delete">
          <Trash2 className="h-4 w-4" strokeWidth={1.5} />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Lines({ title, detail }: { title: string; detail: string | null }) {
  return (
    <span className="min-w-0 flex-1 leading-[1.25]">
      <span className="step-title block truncate text-[12.5px] font-semibold">{title}</span>
      {detail ? <span className="block truncate text-[11px] text-text-2">{detail}</span> : null}
    </span>
  );
}

const TriggerNode = memo(function TriggerNode({ data, selected }: NodeProps<CanvasNode>) {
  return (
    <div
      data-testid="canvas-node-trigger"
      data-selected={selected ? 'true' : 'false'}
      className={cn(
        CARD,
        'gap-2 py-1.5 pl-2 pr-2.5',
        selected
          ? SELECTED
          : 'border-[color-mix(in_oklab,var(--success)_40%,var(--border))] hover:border-[color-mix(in_oklab,var(--success)_60%,var(--border))]',
      )}
    >
      <KindTile tone="trig" icon={triggerIconOf(data.trigger!)} size="sm" />
      <span className="line-clamp-2 min-w-0 flex-1 text-[12.5px] font-semibold leading-[1.25]">
        {data.title}
      </span>
      <Anchors top={false} />
      <Flag flag={data.flag} />
    </div>
  );
});

const StepNode = memo(function StepNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { editable } = useCanvas();
  const step = data.step!;
  return (
    <div
      data-testid={`canvas-node-${id}`}
      data-selected={selected ? 'true' : 'false'}
      data-step-type={step.type}
      className={cn(
        'group/node gap-2 py-1.5 pl-2 pr-1.5',
        CARD,
        selected ? SELECTED : 'border-border hover:border-border-strong',
        overlayClass(data.overlay?.status),
      )}
    >
      <Anchors />
      <KindTile tone={stepTone(step)} icon={stepIcon(step)} size="sm" />
      <Lines title={data.title} detail={data.detail} />
      {editable ? <NodeMenu stepId={id} title={data.title} shown={selected} /> : null}
      {step.type === 'goto' ? (
        <Handle
          type="source"
          position={Position.Right}
          id="goto"
          isConnectable={editable}
          className="wf-hd wf-hd-goto"
          title={editable ? 'Drag onto the step it goes back to' : undefined}
          data-testid={editable ? `goto-handle-${id}` : undefined}
        />
      ) : (
        <GotoTarget />
      )}
      <Flag flag={data.flag} />
      <Overlay overlay={data.overlay} />
    </div>
  );
});

/** A branch step: the split its paths fan out from. */
const SplitNode = memo(function SplitNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { editable } = useCanvas();
  const step = data.step!;
  return (
    <div
      data-testid={`canvas-node-${id}`}
      data-selected={selected ? 'true' : 'false'}
      data-step-type="branch"
      className={cn(
        'group/node gap-2 py-1 pl-1.5 pr-1.5',
        CARD,
        'rounded-full',
        selected
          ? SELECTED
          : 'border-[color-mix(in_oklab,var(--wf-br)_45%,var(--border))] bg-[color-mix(in_oklab,var(--wf-br-soft)_60%,var(--card))] hover:border-[color-mix(in_oklab,var(--wf-br)_65%,var(--border))]',
        overlayClass(data.overlay?.status),
      )}
    >
      <Anchors />
      <KindTile tone={stepTone(step)} icon={stepIcon(step)} size="sm" className="rounded-full" />
      <Lines title={data.title} detail={data.detail} />
      {editable ? <NodeMenu stepId={id} title={data.title} shown={selected} /> : null}
      <GotoTarget />
      <Flag flag={data.flag} />
      <Overlay overlay={data.overlay} />
    </div>
  );
});

/** An End step. */
const EndNode = memo(function EndNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { editable } = useCanvas();
  const step = data.step!;
  return (
    <div
      data-testid={`canvas-node-${id}`}
      data-selected={selected ? 'true' : 'false'}
      data-step-type="end"
      className={cn(
        'group/node gap-1.5 pl-1 pr-1 text-[12.5px] font-medium text-text-2',
        CARD,
        'rounded-full',
        selected ? SELECTED : 'border-border hover:border-border-strong',
        overlayClass(data.overlay?.status),
      )}
    >
      <Anchors />
      <KindTile tone="end" icon={stepIcon(step)} size="sm" className="rounded-full" />
      <span className="step-title flex-1">End</span>
      {editable ? <NodeMenu stepId={id} title="End" shown={selected} /> : null}
      <Flag flag={data.flag} />
      <Overlay overlay={data.overlay} />
    </div>
  );
});

/** Where a branch's paths meet again. */
const JoinNode = memo(function JoinNode() {
  return (
    <div
      className="relative h-full w-full rounded-full border-2 border-text-3 bg-card"
      title="The paths join here"
    >
      <Anchors dots={false} />
    </div>
  );
});

/** The end of the main path ("End") or of a rejected path ("Run ends"). */
const TerminalNode = memo(function TerminalNode({ id, data }: NodeProps<CanvasNode>) {
  return (
    <div
      data-testid={`canvas-node-${id}`}
      className="relative flex h-full w-full items-center gap-1.5 rounded-full border border-border bg-card pl-1 pr-3 text-[12.5px] font-medium text-text-2 shadow-1"
    >
      <Anchors bottom={false} dots={false} />
      <KindTile tone="end" icon={CircleStop} size="sm" className="rounded-full" />
      {data.node.label}
    </div>
  );
});

/** A path with nothing in it yet; its "+" is on the edge above. */
const EmptyNode = memo(function EmptyNode({ id }: NodeProps<CanvasNode>) {
  return (
    <div
      data-testid={`canvas-node-${id}`}
      className="relative flex h-full w-full items-center justify-center rounded-[10px] border border-dashed border-border-strong bg-card text-[12px] text-text-3"
    >
      <Anchors dots={false} />
      No steps yet
    </div>
  );
});

/** One set for the canvas's lifetime, so xyflow never remounts the nodes. */
export const NODE_TYPES = {
  trigger: TriggerNode,
  step: StepNode,
  split: SplitNode,
  end: EndNode,
  join: JoinNode,
  terminal: TerminalNode,
  empty: EmptyNode,
} satisfies NodeTypes;
