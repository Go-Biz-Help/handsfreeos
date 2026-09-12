'use client';
import { cn } from '@/lib/utils';

/**
 * For settings that save the moment they are flipped. The visible label sits beside it in the row; `label`
 * names it for screen readers and on hover.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  testId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      data-testid={testId}
      className={cn(
        'relative inline-flex h-5 w-9 flex-none rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        checked ? 'bg-accent' : 'bg-border-strong',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform duration-150',
          checked && 'translate-x-4',
        )}
      />
    </button>
  );
}
