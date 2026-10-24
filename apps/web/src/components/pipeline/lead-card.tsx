'use client';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Route } from 'lucide-react';
import { createContext, useContext } from 'react';
import { NextActionChip } from '@/components/crm/chips';
import { Avatar } from '@/components/ui/avatar';
import type { LeadCard as Lead } from '@/lib/api/types';
import { daysLabel, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/** The board's funnel and who of its cards is in it (teammate funnels), for the badge on each card. */
export const FunnelOnBoard = createContext<{
  readonly name: string;
  readonly leads: ReadonlyMap<string, { readonly paused: boolean }>;
} | null>(null);

export function LeadCardView({
  lead,
  selected,
  dragging,
  onOpen,
}: {
  lead: Lead;
  selected?: boolean;
  dragging?: boolean;
  onOpen?: () => void;
}) {
  const who = lead.person?.fullName ?? lead.company?.name ?? '';
  // The next action's time has passed: the overdue dot.
  const overdue = lead.nextActionOverdue;
  const sub = lead.person && lead.company ? `${lead.company.name} · ${who}` : who;
  const funnel = useContext(FunnelOnBoard);
  const inFunnel = funnel?.leads.get(lead.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.();
        }
      }}
      data-testid={`lead-card-${lead.id}`}
      className={cn(
        'w-full rounded-menu border bg-card p-3 text-left shadow-1 transition-colors',
        selected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-border-strong',
        dragging && 'rotate-[1deg] shadow-2',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-semibold leading-tight">{lead.title}</span>
        <GripVertical
          className="h-4 w-4 flex-none text-text-3 opacity-60"
          strokeWidth={1.5}
          aria-hidden
        />
      </div>
      <div className="mt-0.5 truncate text-[13px] text-text-2">{sub}</div>
      {funnel && inFunnel ? (
        <span
          className={cn(
            'mt-1.5 inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium',
            inFunnel.paused
              ? 'bg-warning-soft text-warning-text'
              : 'bg-accent-soft text-accent-text',
          )}
          title={
            inFunnel.paused
              ? `${funnel.name} is paused for them while your team talks to them`
              : `In ${funnel.name}`
          }
          data-testid={`lead-card-funnel-${lead.id}`}
        >
          <Route className="h-3 w-3 flex-none" strokeWidth={2} aria-hidden />
          <span className="truncate">
            {inFunnel.paused ? 'Paused · ' : ''}
            {funnel.name}
          </span>
        </span>
      ) : null}
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[13px] font-semibold">{formatMoney(lead.valueCents)}</span>
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-text-3">{daysLabel(lead.stageEnteredAt)}</span>
          {lead.assignee ? (
            <Avatar name={lead.assignee.fullName} seed={lead.assignee.id} size="sm" />
          ) : null}
        </span>
      </div>
      {lead.status === 'open' ? (
        <div className="mt-2 flex min-w-0 items-center gap-1.5">
          {overdue ? (
            <span
              role="img"
              aria-label="Next action is overdue"
              title="Next action is overdue"
              className="h-2 w-2 flex-none rounded-full bg-danger"
              data-testid="lead-overdue-dot"
            />
          ) : null}
          <NextActionChip
            text={lead.nextAction}
            compact={!!lead.nextAction}
            className="min-w-0 max-w-full"
          />
        </div>
      ) : null}
    </div>
  );
}

export function SortableLeadCard({
  lead,
  selected,
  onOpen,
  disabled,
}: {
  lead: Lead;
  selected?: boolean;
  onOpen: () => void;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: lead.id,
    data: { stageId: lead.stageId },
    disabled,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('touch-manipulation', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <LeadCardView lead={lead} selected={selected} onOpen={onOpen} />
    </div>
  );
}
