import { AlertTriangle, Clock } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** A workspace tag: pill with the tag's color dot. */
export function TagChip({
  name,
  color,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { name: string; color: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full bg-card-2 px-2 text-xs font-medium text-text-2',
        className,
      )}
      {...props}
    >
      <i className="inline-block h-[7px] w-[7px] rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

/** A pipeline stage: square-cornered so it never reads as a tag. */
export function StageBadge({
  name,
  kind,
  className,
}: {
  name: string;
  kind: 'open' | 'won' | 'lost';
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-[6px] px-2 text-xs font-medium',
        kind === 'won'
          ? 'bg-success-soft text-success-text'
          : kind === 'lost'
            ? 'bg-danger-soft text-danger-text'
            : 'bg-accent-soft text-accent-text',
        className,
      )}
    >
      {name}
    </span>
  );
}

/** The next-action line of a lead: the action, or the only warning tint on the pipeline. */
export function NextActionChip({
  text,
  className,
  compact,
}: {
  text: string | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (text)
    return (
      <span
        className={cn(
          'inline-flex max-w-full items-center gap-1.5 rounded-[6px] bg-accent-soft px-2 py-1 text-xs font-medium text-accent-text',
          className,
        )}
        title={text}
      >
        <Clock className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
        <span className="truncate">{compact ? text : `Next: ${text}`}</span>
      </span>
    );
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-[7px] bg-warning-soft px-2 py-1 text-xs font-medium text-warning-text',
        className,
      )}
      data-testid="next-action-warning"
    >
      <AlertTriangle className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      {compact ? 'None' : 'No follow-up scheduled'}
    </span>
  );
}

export function Callout({
  tone = 'warning',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  tone?: 'warning' | 'info' | 'danger';
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      {...props}
      className={cn(
        'flex items-start gap-2.5 rounded-menu px-3.5 py-3 text-[13.5px]',
        tone === 'warning' && 'bg-warning-soft text-warning-text',
        tone === 'info' && 'bg-accent-soft text-accent-text',
        tone === 'danger' && 'bg-danger-soft text-danger-text',
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" strokeWidth={1.75} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
