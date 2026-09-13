import { LABEL_NAMES, type CalendarLabel } from '@hfos/core';
import { Badge } from '@/components/ui/badge';
import type { CalendarStatus } from '@/lib/api/types';
import { cn } from '@/lib/utils';

/** A label's display name; stored labels are keys like 'round_robin'. */
export const labelName = (tag: string): string =>
  LABEL_NAMES[tag as CalendarLabel] ?? tag.replace(/_/g, ' ');

/** "Dispatch · Round Robin · Service" as text. */
export const labelsText = (tags: readonly string[]): string =>
  (tags.length ? tags : ['custom']).map(labelName).join(' · ');

/** The inferred labels: the first (primary) one tinted. They describe; they never lock anything. */
export function LabelChips({
  tags,
  className,
  testId,
}: {
  tags: readonly string[];
  className?: string;
  testId?: string;
}) {
  return (
    <span className={cn('flex flex-wrap items-center gap-1.5', className)} data-testid={testId}>
      {(tags.length ? tags : ['custom']).map((t, i) => (
        <span
          key={t}
          className={cn(
            'inline-flex h-[22px] items-center whitespace-nowrap rounded-[6px] px-2 text-xs font-medium',
            i === 0 ? 'bg-accent-soft text-accent-text' : 'bg-card-2 text-text-2',
          )}
        >
          {labelName(t)}
        </span>
      ))}
    </span>
  );
}

const STATUS: Record<
  CalendarStatus,
  { variant: 'ok' | 'gray' | 'pending' | 'danger'; label: string }
> = {
  active: { variant: 'ok', label: 'Active' },
  draft: { variant: 'gray', label: 'Draft' },
  paused: { variant: 'pending', label: 'Paused' },
  archived: { variant: 'danger', label: 'Archived' },
};

export function CalendarStatusBadge({ status }: { status: CalendarStatus }) {
  const s = STATUS[status];
  return (
    <Badge variant={s.variant} data-testid="calendar-status">
      {s.label}
    </Badge>
  );
}

/** A calendar's color swatch. */
export function CalendarDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 flex-none rounded-full', className)}
      style={{ background: color }}
    />
  );
}
