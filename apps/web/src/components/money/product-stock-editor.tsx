'use client';
/**
 * A product's stock, in Settings → Payments → Products (core's money/stock.ts): whether HandsFreeOS counts how many
 * are on hand, as a whole or by one of its options (each size of a T-shirt), the counts, and the number to hear at.
 * Orders take theirs off when they're picked up or delivered, so a count typed here is only sent when it's changed:
 * one left alone can't undo an order marked picked up while the editor was open.
 */
import { MAX_STOCK_COUNT, stockState, type ProductStock, type StockInput } from '@hfos/core';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { OptionDraft } from './product-options-editor';

export interface StockDraft {
  readonly on: boolean;
  /** The option it's counted by, or null for the whole product. */
  readonly optionId: string | null;
  /** The number to hear at, as typed: blank for never. */
  readonly lowAt: string;
  /** Each count as typed, by choice id ('' for the whole product). */
  readonly counts: Readonly<Record<string, string>>;
  /** The counts this person changed: only these are sent. */
  readonly touched: readonly string[];
  /** Whether it was counted when the editor opened, so turning it off is sent. */
  readonly was: boolean;
}

export const stockDraftOf = (stock: ProductStock | null): StockDraft => ({
  on: !!stock,
  optionId: stock?.optionId ?? null,
  lowAt: stock?.lowAt === null || stock?.lowAt === undefined ? '' : String(stock.lowAt),
  counts: Object.fromEntries(Object.entries(stock?.counts ?? {}).map(([k, v]) => [k, String(v)])),
  touched: [],
  was: !!stock,
});

const whole = (text: string): number | null => {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return Math.abs(n) <= MAX_STOCK_COUNT ? n : null;
};

/** The option it's counted by, if it's still one of the product's. */
const countedOption = (draft: StockDraft, options: readonly OptionDraft[]) =>
  draft.optionId ? (options.find((o) => o.id === draft.optionId) ?? null) : null;

/** Whether every box reads: counts are whole numbers, and the number to hear at is blank or 0 or more. */
export function stockDraftReady(draft: StockDraft): boolean {
  if (!draft.on) return true;
  if (draft.lowAt.trim() && (whole(draft.lowAt) === null || whole(draft.lowAt)! < 0)) return false;
  return draft.touched.every((k) => whole(draft.counts[k] ?? '') !== null);
}

/** What the save sends: the stock, null to stop counting, or nothing when it never was counted. */
export function stockBody(
  draft: StockDraft,
  options: readonly OptionDraft[],
): StockInput | null | undefined {
  if (!draft.on) return draft.was ? null : undefined;
  const option = countedOption(draft, options);
  const label = (choiceId: string) =>
    option?.choices.find((c) => c.id === choiceId)?.label.trim() ?? null;
  return {
    countBy: option ? option.name.trim() : null,
    lowAt: draft.lowAt.trim() ? whole(draft.lowAt) : null,
    counts: draft.touched.flatMap((choiceId) => {
      const onHand = whole(draft.counts[choiceId] ?? '');
      if (onHand === null) return [];
      if (!option) return choiceId === '' ? [{ choice: '', onHand }] : [];
      const name = label(choiceId);
      return name ? [{ choice: name, onHand }] : [];
    }),
  };
}

export function ProductStockEditor({
  draft,
  options,
  onChange,
}: {
  draft: StockDraft;
  options: readonly OptionDraft[];
  onChange: (draft: StockDraft) => void;
}) {
  const option = countedOption(draft, options);
  const named = options.filter((o) => o.name.trim());
  const lowAt = draft.lowAt.trim() ? whole(draft.lowAt) : null;
  const setCount = (choiceId: string, text: string) =>
    onChange({
      ...draft,
      counts: { ...draft.counts, [choiceId]: text },
      touched: draft.touched.includes(choiceId) ? draft.touched : [...draft.touched, choiceId],
    });
  const rows = option
    ? option.choices.map((c) => ({ id: c.id, label: c.label.trim() || 'New choice' }))
    : [{ id: '', label: 'On hand' }];

  return (
    <div data-testid="product-stock-editor">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium">Count how many I have</span>
          <span className="text-xs text-text-3">
            An order takes its own off when it’s picked up or delivered.
          </span>
        </span>
        <Switch
          checked={draft.on}
          label="Count how many I have"
          onChange={(on) => onChange({ ...draft, on })}
          testId="product-stock"
        />
      </div>

      {draft.on ? (
        <div className="mt-3 flex flex-col gap-3">
          {named.length ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Count it</span>
              <Select
                selectSize="sm"
                value={option?.id ?? ''}
                onChange={(e) => onChange({ ...draft, optionId: e.target.value || null })}
                data-testid="product-stock-by"
              >
                <option value="">As a whole</option>
                {named.map((o) => (
                  <option key={o.id} value={o.id}>
                    By {o.name.trim().toLowerCase()}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}

          <div className="flex flex-col gap-1.5" data-testid="product-stock-counts">
            {rows.map((r) => {
              const text = draft.counts[r.id] ?? '';
              const n = whole(text);
              const state = n === null ? null : stockState(n, lowAt);
              return (
                <label
                  key={r.id || 'whole'}
                  className={cn(
                    'flex items-center justify-between gap-2 rounded-control border border-border px-2.5 py-1.5',
                    state === 'out' && 'border-danger-border bg-danger-soft',
                    state === 'low' && 'border-warning-border bg-warning-soft',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{r.label}</span>
                  <Input
                    inputSize="sm"
                    inputMode="numeric"
                    className="w-[84px] flex-none text-right tabular-nums"
                    value={text}
                    placeholder="0"
                    aria-label={option ? `${r.label} on hand` : 'On hand'}
                    aria-invalid={text.trim() !== '' && n === null}
                    onChange={(e) => setCount(r.id, e.target.value)}
                    data-testid={option ? `stock-count-${r.label}` : 'stock-count'}
                  />
                </label>
              );
            })}
          </div>

          <label className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium">Tell me when it’s down to</span>
              <span className="text-xs text-text-3">
                {option
                  ? `Any ${option.name.trim().toLowerCase() || 'choice'}. Blank for never.`
                  : 'Blank for never.'}
              </span>
            </span>
            <Input
              inputSize="sm"
              inputMode="numeric"
              className="w-[72px] text-right tabular-nums"
              value={draft.lowAt}
              placeholder="—"
              aria-label="Tell me when it’s down to"
              onChange={(e) => onChange({ ...draft, lowAt: e.target.value })}
              data-testid="product-stock-low"
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}
