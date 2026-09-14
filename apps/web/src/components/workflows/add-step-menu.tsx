'use client';
import {
  ACTION_LABELS,
  insertionPoints,
  type ActionKey,
  type InsertionPoint,
  type WorkflowDefinition,
} from '@hfos/core';
import {
  CircleStop,
  CornerUpLeft,
  Hourglass,
  Plus,
  ShieldCheck,
  Sparkles,
  Split,
  type LucideIcon,
} from 'lucide-react';
import { Fragment } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { NewStepKind, StepTone } from '@/lib/workflows/steps';
import { cn } from '@/lib/utils';
import { actionIcon, KindTile } from './chips';

interface MenuItem {
  readonly key: string;
  readonly label: string;
  readonly kind: NewStepKind;
  readonly tone: StepTone;
  readonly icon: LucideIcon;
}

const action = (a: ActionKey): MenuItem => ({
  key: a,
  label: ACTION_LABELS[a],
  kind: { kind: 'action', action: a },
  tone: 'act',
  icon: actionIcon(a),
});

/** The actions grouped by what they touch, then the steps that shape the flow. */
const GROUPS: readonly { title: string; items: readonly MenuItem[] }[] = [
  { title: 'Message the customer', items: [action('send_text'), action('send_email')] },
  {
    title: 'The customer',
    items: [action('update_person'), action('add_tag'), action('remove_tag'), action('add_note')],
  },
  {
    title: 'The lead',
    items: [
      action('create_lead'),
      action('move_lead_stage'),
      action('assign_lead'),
      action('set_next_action'),
    ],
  },
  {
    title: 'Tasks and the team',
    items: [action('create_task'), action('complete_task'), action('notify_team')],
  },
  {
    title: 'The conversation',
    items: [action('assign_conversation'), action('close_conversation')],
  },
  {
    title: 'Other workflows and apps',
    items: [action('enrol_workflow'), action('remove_from_workflow'), action('webhook_out')],
  },
  {
    title: 'Timing and paths',
    items: [
      { key: 'wait', label: 'Wait', kind: { kind: 'wait' }, tone: 'wait', icon: Hourglass },
      { key: 'if_else', label: 'If / else', kind: { kind: 'if_else' }, tone: 'br', icon: Split },
      {
        key: 'multi',
        label: 'Split into paths',
        kind: { kind: 'multi' },
        tone: 'br',
        icon: Split,
      },
      {
        key: 'ai_sort',
        label: 'AI picks a path',
        kind: { kind: 'ai_sort' },
        tone: 'ai',
        icon: Sparkles,
      },
    ],
  },
  {
    title: 'AI and approvals',
    items: [
      { key: 'ai', label: 'AI step', kind: { kind: 'ai' }, tone: 'ai', icon: Sparkles },
      {
        key: 'approval',
        label: 'Approval',
        kind: { kind: 'approval' },
        tone: 'appr',
        icon: ShieldCheck,
      },
    ],
  },
  {
    title: 'Finish a path',
    items: [
      {
        key: 'goto',
        label: 'Go to another step',
        kind: { kind: 'goto' },
        tone: 'br',
        icon: CornerUpLeft,
      },
      { key: 'end', label: 'End', kind: { kind: 'end' }, tone: 'end', icon: CircleStop },
    ],
  },
];

export const slotTestId = (at: InsertionPoint): string =>
  at.afterStepId
    ? `add-after-${at.afterStepId}`
    : `add-start-${at.parentId ?? 'root'}${at.branchId ? `-${at.branchId}` : ''}`;

/** The "+" between steps and its menu. A go-to is offered only where it can go (the end of a path). */
export function AddStepMenu({
  def,
  at,
  onPick,
  className,
}: {
  def: WorkflowDefinition;
  at: InsertionPoint;
  onPick: (kind: NewStepKind, label: string) => void;
  className?: string;
}) {
  const gotoHere = insertionPoints(def, 'goto').some(
    (p) => p.parentId === at.parentId && p.branchId === at.branchId && p.index === at.index,
  );
  const lastInLane = at.beforeStepId === null;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Add a step here"
          data-testid={slotTestId(at)}
          className={cn(
            'relative z-[1] inline-flex h-[22px] w-[22px] items-center justify-center rounded-full border border-border-strong bg-card text-text-3 transition-colors hover:border-accent hover:bg-accent-soft hover:text-accent-text focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:border-accent data-[state=open]:bg-accent-soft data-[state=open]:text-accent-text',
            className,
          )}
        >
          <Plus className="h-3 w-3" strokeWidth={2.2} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        className="max-h-[min(440px,70vh)] w-[260px] overflow-y-auto"
        data-testid="add-step-menu"
      >
        <DropdownMenuLabel className="pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.04em]">
          Add a step
        </DropdownMenuLabel>
        {GROUPS.map((g) => {
          const items = g.items.filter(
            (i) => (i.key !== 'goto' || gotoHere) && (i.key !== 'end' || lastInLane),
          );
          if (!items.length) return null;
          return (
            <Fragment key={g.title}>
              <DropdownMenuLabel className="pb-0.5 pt-2 text-[11px] font-medium">
                {g.title}
              </DropdownMenuLabel>
              {items.map((i) => (
                <DropdownMenuItem
                  key={i.key}
                  data-testid={`add-step-${i.key}`}
                  className="h-8 gap-[9px] text-[13px]"
                  onSelect={() => onPick(i.kind, i.label)}
                >
                  <KindTile tone={i.tone} icon={i.icon} size="xs" />
                  {i.label}
                </DropdownMenuItem>
              ))}
            </Fragment>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
