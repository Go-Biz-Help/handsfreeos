'use client';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A small number with − and + (weights, crew size, quantities). */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 100,
  label,
  disabled,
  className,
  testId,
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** Names the value for screen readers ("Weight for Priya"). */
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const btn =
    'inline-flex h-[30px] w-[30px] items-center justify-center text-text-2 hover:bg-card-2 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring';
  return (
    <span
      role="group"
      aria-label={label}
      data-testid={testId}
      className={cn(
        'inline-flex h-8 flex-none items-center overflow-hidden rounded-control border border-border-strong bg-card',
        disabled && 'opacity-60',
        className,
      )}
    >
      <button
        type="button"
        className={btn}
        aria-label={`Less (${label})`}
        disabled={disabled || value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
      <span
        className="min-w-[26px] text-center text-[13.5px] font-semibold tabular-nums"
        aria-live="polite"
      >
        {value}
      </span>
      <button
        type="button"
        className={btn}
        aria-label={`More (${label})`}
        disabled={disabled || value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
      </button>
    </span>
  );
}
