'use client';
/**
 * Settings → Automations' small inputs: numbers and dollars that save when they're left, and the wording
 * checklist's lines. Moved from the Action Center's settings page when it became part of Automations.
 */
import { AlertTriangle, Check } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { formatMoney, parseMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/** A whole number that saves when it's left (or on Enter), and goes back if it's out of range. */
export function NumberBox({
  value,
  min,
  max,
  unit,
  label,
  disabled,
  onCommit,
  className,
  testId,
}: {
  value: number;
  min: number;
  max: number;
  unit?: string;
  label: string;
  disabled?: boolean;
  onCommit: (next: number) => void;
  className?: string;
  testId?: string;
}) {
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setText(String(value));
  }
  const commit = () => {
    const raw = text.trim();
    if (raw === String(value)) return;
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n < min || n > max) {
      toast.error(`Use a whole number from ${min} to ${max}.`);
      setText(String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <span className="flex items-center gap-1.5">
      <Input
        inputSize="sm"
        inputMode="numeric"
        aria-label={label}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className={cn('w-16 px-2.5 tabular-nums', className)}
        data-testid={testId}
      />
      {unit ? <span className="text-xs text-text-3">{unit}</span> : null}
    </span>
  );
}

/** Dollars that save when they're left. `optional` lets it be emptied (the worked-out value then). */
export function MoneyBox({
  cents,
  label,
  optional,
  placeholder,
  onCommit,
  testId,
}: {
  cents: number | null;
  label: string;
  optional?: boolean;
  placeholder?: string;
  onCommit: (next: number | null) => void;
  testId?: string;
}) {
  const shownText = cents === null ? '' : formatMoney(cents);
  const [text, setText] = useState(shownText);
  const [shown, setShown] = useState(shownText);
  if (shown !== shownText) {
    setShown(shownText);
    setText(shownText);
  }
  const commit = () => {
    const raw = text.trim();
    if (raw === shownText) return;
    if (!raw) {
      if (optional) onCommit(null);
      else setText(shownText);
      return;
    }
    const next = parseMoney(raw);
    if (next === null || next > 100_000_000_00) {
      toast.error('Use an amount in dollars, like $4,200.');
      setText(shownText);
      return;
    }
    setText(formatMoney(next));
    if (next !== cents) onCommit(next);
  };
  return (
    <Input
      inputSize="sm"
      inputMode="decimal"
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="w-24 px-2.5 tabular-nums max-md:w-28"
      data-testid={testId}
    />
  );
}

/** One line of the wording's checklist: a green tick, or an amber warning. */
export function Check1({
  ok,
  children,
  testId,
}: {
  ok: boolean;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <span
      className="flex items-center gap-2 text-[13px] text-text-2"
      data-testid={testId}
      data-ok={ok}
    >
      {ok ? (
        <Check className="h-4 w-4 flex-none text-success-text" strokeWidth={2} aria-label="OK" />
      ) : (
        <AlertTriangle
          className="h-4 w-4 flex-none text-warning-text"
          strokeWidth={1.75}
          aria-label="Needs a change"
        />
      )}
      {children}
    </span>
  );
}

/** "Wed, Sep 23": tomorrow, for the reminder's sample (in the browser, so the server's zone never shows). */
export function tomorrowLabel(now: number): string {
  const d = new Date(now + 86_400_000);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
