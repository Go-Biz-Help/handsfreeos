'use client';
/**
 * A "How many of each" question as the person answering sees it (core's forms/quantities.ts): a number box beside
 * each row, a minus and a plus for a thumb, and the total under them, with what it comes to when the rows have
 * prices. Two columns once there are enough rows to need them, as on a paper order form; one on a phone.
 *
 * The answer only ever holds rows above 0, so clearing every box is no answer again.
 */
import {
  MAX_QUANTITY,
  money,
  quantityRowsOf,
  quantityTotal,
  quantityTotalWords,
  quantityWorthCents,
  rowPriceCents,
  type AnswerValue,
  type Question,
} from '@hfos/core';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Two columns from this many rows; fewer read better as one list. */
const TWO_COLUMNS_FROM = 5;

export function QuantitiesField({
  question,
  value,
  onChange,
  inputId,
}: {
  question: Question;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  /** The first box's id, so the question's label lands on it. */
  inputId: string;
}) {
  const rows = quantityRowsOf(question);
  const config = question.config as { unit?: string; showPrices?: boolean };
  const showPrices = config.showPrices !== false;
  const counts: Record<string, number> =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, number>) }
      : {};

  const set = (rowId: string, next: number | null) => {
    const out = { ...counts };
    if (next === null || !Number.isFinite(next) || next <= 0) delete out[rowId];
    else out[rowId] = Math.min(next, MAX_QUANTITY);
    onChange(Object.keys(out).length ? out : null);
  };

  const total = quantityTotal(counts);
  const worth = showPrices ? quantityWorthCents(question, counts) : null;

  return (
    <div role="group" aria-label={question.title}>
      <ul
        className={cn('grid gap-2', rows.length >= TWO_COLUMNS_FROM && 'sm:grid-cols-2 sm:gap-x-4')}
      >
        {rows.map((row, i) => {
          const count = counts[row.id] ?? 0;
          const price = showPrices ? rowPriceCents(row) : null;
          return (
            <li
              key={row.id}
              className={cn(
                'flex items-center gap-3 rounded-control border px-3 py-2 transition-colors',
                count > 0 ? 'border-accent bg-accent/5' : 'border-border',
              )}
              data-testid={`quantity-row-${row.id}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-text">{row.label}</span>
                {price !== null ? (
                  <span className="block text-[12px] text-text-3">{money(price)} each</span>
                ) : null}
              </span>
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-border text-text-2 transition-colors hover:bg-card-2 disabled:opacity-40"
                aria-label={`One fewer ${row.label}`}
                disabled={count <= 0}
                onClick={() => set(row.id, count - 1)}
              >
                <Minus className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <input
                id={i === 0 ? inputId : undefined}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_QUANTITY}
                step={1}
                aria-label={`How many ${row.label}`}
                className="h-8 w-14 shrink-0 rounded-control border border-border-strong bg-card px-1 text-center text-[15px] tabular-nums text-text [appearance:textfield] focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring max-md:text-base [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={count > 0 ? String(count) : ''}
                placeholder="0"
                onChange={(e) =>
                  set(row.id, e.target.value === '' ? null : Math.floor(Number(e.target.value)))
                }
                data-testid={`quantity-input-${row.id}`}
              />
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control border border-border text-text-2 transition-colors hover:bg-card-2 disabled:opacity-40"
                aria-label={`One more ${row.label}`}
                disabled={count >= MAX_QUANTITY}
                onClick={() => set(row.id, count + 1)}
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </li>
          );
        })}
      </ul>
      <p
        className="mt-2 flex justify-between text-[13px] text-text-2"
        aria-live="polite"
        data-testid="quantity-total"
      >
        <span>{quantityTotalWords(total, config.unit ?? '')}</span>
        {worth !== null ? (
          <span className="font-medium tabular-nums text-text">{money(worth)}</span>
        ) : null}
      </p>
    </div>
  );
}
