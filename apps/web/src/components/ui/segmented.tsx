'use client';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly icon?: ReactNode;
  readonly testId?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  fill,
  size = 'md',
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegmentedOption<T>[];
  className?: string;
  /** Stretch to the container, equal buttons (the inbox boxes). */
  fill?: boolean;
  /** `lg` is the 36px phone height. */
  size?: 'md' | 'lg';
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        fill ? 'flex' : 'inline-flex',
        'rounded-[9px] border border-border bg-card-2 p-[3px]',
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          data-testid={o.testId}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 text-[13px] font-medium transition-colors',
            size === 'lg' ? 'h-9' : 'h-7',
            fill && 'min-w-0 flex-1 px-2',
            o.value === value ? 'bg-card text-text shadow-1' : 'text-text-2 hover:text-text',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
