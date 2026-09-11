'use client';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Badge } from '@/components/ui/badge';
import type { LeadBoard } from '@/lib/api/types';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SortableLeadCard } from './lead-card';

type StageOnBoard = LeadBoard['stages'][number];

export function StageColumn({
  stage,
  selectedId,
  onOpen,
  disabled,
}: {
  stage: StageOnBoard;
  selectedId: string | null;
  onOpen: (id: string) => void;
  disabled?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, data: { stageId: stage.id } });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-[262px] flex-none snap-start flex-col gap-2 rounded-card bg-card-2 p-2 transition-colors max-md:w-[300px]',
        isOver && 'bg-accent-soft',
      )}
      data-testid={`stage-column-${stage.name.replace(/\s+/g, '-').toLowerCase()}`}
    >
      <div className="flex items-center justify-between px-1.5 pb-0.5 pt-1.5">
        <span className="flex items-center gap-2">
          <span className="text-[13px] font-semibold">{stage.name}</span>
          <Badge variant="gray" className="h-5">
            {stage.count}
          </Badge>
        </span>
        <span className="text-xs text-text-3">
          {stage.count ? formatMoney(stage.valueCents) : ''}
        </span>
      </div>
      <SortableContext items={stage.leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
        {stage.leads.map((l) => (
          <SortableLeadCard
            key={l.id}
            lead={l}
            selected={l.id === selectedId}
            onOpen={() => onOpen(l.id)}
            disabled={disabled}
          />
        ))}
      </SortableContext>
      {stage.leads.length === 0 ? (
        <div className="rounded-control border border-dashed border-border-strong px-2 py-3.5 text-center text-xs text-text-3">
          Drop a lead here
        </div>
      ) : null}
    </div>
  );
}
