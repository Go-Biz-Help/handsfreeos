import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A pick-one card (role, kind, policy). Uses the radio role so keyboard and screen readers get a group. */
export function RadioCard({
  selected,
  onSelect,
  title,
  description,
  className,
  testId,
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        'flex flex-1 items-start gap-3 rounded-menu border p-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        selected ? 'border-accent bg-accent-soft' : 'border-border bg-card hover:bg-card-2',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-0.5 inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full border-[1.5px]',
          selected ? 'border-accent' : 'border-border-strong',
        )}
      >
        {selected ? <span className="h-2.5 w-2.5 rounded-full bg-accent" /> : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold">{title}</span>
        {description ? <span className="text-[13px] text-text-2">{description}</span> : null}
      </span>
    </button>
  );
}
