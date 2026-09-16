'use client';
import { money, parseMoney } from '@hfos/core';
import { useEffect, useState } from 'react';
import { Input, type InputProps } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The text an amount of cents starts life as in a field: "$6,400" reads better than "6400". */
export function moneyText(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : money(cents);
}

/**
 * An amount in cents, typed. Keeps what was typed while it's being typed (so "1." isn't rewritten mid-keystroke)
 * and reports cents only once core's `parseMoney` accepts it — which refuses letters, negatives and nonsense
 * rather than quietly reading them as zero, so the field goes red instead of the total going wrong.
 */
export function MoneyInput({
  valueCents,
  onChange,
  onInvalid,
  className,
  ...rest
}: Omit<InputProps, 'value' | 'onChange' | 'defaultValue'> & {
  valueCents: number;
  onChange: (cents: number) => void;
  /** Told whenever what's typed stops or starts being an amount, so a form can refuse to save. */
  onInvalid?: (invalid: boolean) => void;
}) {
  const [text, setText] = useState(() => moneyText(valueCents));
  const [touched, setTouched] = useState(false);
  // A value that changed elsewhere (a line rebuilt from the catalogue) shows up here unless it's being typed.
  useEffect(() => {
    if (!touched) setText(moneyText(valueCents));
  }, [valueCents, touched]);

  const cents = parseMoney(text);
  const invalid = cents === null;
  useEffect(() => onInvalid?.(invalid), [invalid, onInvalid]);

  return (
    <Input
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      invalid={invalid}
      className={cn('text-right tabular-nums', className)}
      onChange={(e) => {
        setTouched(true);
        setText(e.target.value);
        const next = parseMoney(e.target.value);
        if (next !== null) onChange(next);
      }}
      onBlur={(e) => {
        setTouched(false);
        const next = parseMoney(e.target.value);
        setText(moneyText(next ?? valueCents));
        rest.onBlur?.(e);
      }}
    />
  );
}

/**
 * A quantity: up to three decimal places, more than none. Same shape as `MoneyInput` — what's typed stays until
 * it's left, and nonsense is refused rather than read as zero.
 */
export function QuantityInput({
  value,
  onChange,
  onInvalid,
  className,
  ...rest
}: Omit<InputProps, 'value' | 'onChange' | 'defaultValue'> & {
  value: number;
  onChange: (quantity: number) => void;
  onInvalid?: (invalid: boolean) => void;
}) {
  const [text, setText] = useState(() => String(value));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(String(value));
  }, [value, touched]);

  const parsed = parseQuantity(text);
  const invalid = parsed === null;
  useEffect(() => onInvalid?.(invalid), [invalid, onInvalid]);

  return (
    <Input
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      invalid={invalid}
      className={cn('text-right tabular-nums', className)}
      onChange={(e) => {
        setTouched(true);
        setText(e.target.value);
        const next = parseQuantity(e.target.value);
        if (next !== null) onChange(next);
      }}
      onBlur={(e) => {
        setTouched(false);
        setText(String(parseQuantity(e.target.value) ?? value));
        rest.onBlur?.(e);
      }}
    />
  );
}

/** A percentage, held in basis points: "10" is 1,000 and "8.25" is 825. */
export function PercentInput({
  valueBp,
  onChange,
  max = 10_000,
  className,
  ...rest
}: Omit<InputProps, 'value' | 'onChange' | 'defaultValue' | 'max'> & {
  valueBp: number;
  onChange: (bp: number) => void;
  max?: number;
}) {
  const [text, setText] = useState(() => bpText(valueBp));
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(bpText(valueBp));
  }, [valueBp, touched]);

  const parsed = parsePercent(text, max);
  return (
    <Input
      {...rest}
      inputMode="decimal"
      autoComplete="off"
      value={text}
      invalid={parsed === null}
      className={cn('text-right tabular-nums', className)}
      onChange={(e) => {
        setTouched(true);
        setText(e.target.value);
        const next = parsePercent(e.target.value, max);
        if (next !== null) onChange(next);
      }}
      onBlur={(e) => {
        setTouched(false);
        setText(bpText(parsePercent(e.target.value, max) ?? valueBp));
        rest.onBlur?.(e);
      }}
    />
  );
}

/** 825 → "8.25", 1000 → "10". */
export function bpText(bp: number): string {
  const value = (bp ?? 0) / 100;
  return String(Number.isInteger(value) ? value : Number(value.toFixed(2)));
}

export function parsePercent(input: string, max = 10_000): number | null {
  const text = (input ?? '').trim().replace(/%$/, '');
  if (!/^\d*(?:\.\d{0,2})?$/.test(text) || text === '' || text === '.') return null;
  const bp = Math.round(Number(text) * 100);
  if (!Number.isFinite(bp) || bp < 0 || bp > max) return null;
  return bp;
}

/** More than none, three decimal places at most — the same rule the command's schema applies. */
export function parseQuantity(input: string): number | null {
  const text = (input ?? '').trim();
  if (!/^\d*(?:\.\d{0,3})?$/.test(text) || text === '' || text === '.') return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return n;
}
