'use client';
import { cn } from '@/lib/utils';

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn('inline-flex rounded-[9px] border border-border bg-card-2 p-[3px]', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-7 rounded-[6px] px-3 text-[13px] font-medium transition-colors',
            o.value === value ? 'bg-card text-text shadow-1' : 'text-text-2 hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
