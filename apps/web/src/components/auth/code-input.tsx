'use client';
import { useState } from 'react';
import { CODE_LENGTH } from '@/lib/auth/code-messages';
import { cn } from '@/lib/utils';

/**
 * The emailed code, as six boxes: one real input lies over them, so typing, pasting a whole code, and the browser's
 * own one-time-code fill all work, and the boxes only show what it holds.
 */
export function CodeInput({
  id,
  value,
  onChange,
  invalid,
  disabled,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
}) {
  const [focused, setFocused] = useState(false);
  const current = Math.min(value.length, CODE_LENGTH - 1);
  return (
    <div className="relative">
      <input
        id={id}
        name="code"
        aria-label="6-digit code"
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="one-time-code"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={CODE_LENGTH}
        autoFocus
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        data-testid="code-input"
        className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0 disabled:cursor-not-allowed"
      />
      <div aria-hidden className="grid grid-cols-6 gap-2">
        {Array.from({ length: CODE_LENGTH }, (_, i) => {
          const active = focused && !disabled && i === current && value.length < CODE_LENGTH;
          return (
            <span
              key={i}
              className={cn(
                'flex h-[52px] items-center justify-center rounded-menu border bg-card text-[24px] font-semibold tabular-nums transition-[border-color,box-shadow] max-md:h-12',
                invalid ? 'border-danger' : 'border-border-strong',
                active && 'border-accent ring-[3px] ring-ring',
                disabled && 'bg-card-2 text-text-2',
              )}
            >
              {value[i] ??
                (active ? <span className="h-7 w-0.5 animate-pulse rounded bg-accent" /> : null)}
            </span>
          );
        })}
      </div>
    </div>
  );
}
