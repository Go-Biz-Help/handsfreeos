'use client';
import {
  choiceBumpWords,
  money,
  nameWithChoices,
  pickedChoices,
  priceWithChoices,
  productHasOptions,
  type OptionPicks,
} from '@hfos/core';
import { ChevronLeft, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProductRow } from '@/lib/api/types';
import { cn } from '@/lib/utils';

export interface PickedProduct {
  readonly productId: string | null;
  readonly name: string;
  readonly description: string | null;
  readonly unitPriceCents: number;
  readonly unitLabel: string;
  readonly taxable: boolean;
  /** The product's choices picked for it (Adult 2XL, Black), which an order keeps for counting stock by choice. */
  readonly choiceIds: readonly string[];
}

/** A typed-in line: no catalogue row behind it, and the price is whatever the document says. */
export function blankLine(name: string): PickedProduct {
  return {
    productId: null,
    name: name.trim() || 'New line',
    description: null,
    unitPriceCents: 0,
    unitLabel: 'each',
    taxable: true,
    choiceIds: [],
  };
}

/** A product as a line, with the choices picked for it: "T-shirt (Adult 2XL)" at its price with the bump. */
const pick = (p: ProductRow, picks: OptionPicks = {}): PickedProduct => {
  const { choices } = pickedChoices(p, picks);
  return {
    productId: p.id,
    name: nameWithChoices(p.name, choices),
    description: p.description,
    unitPriceCents: priceWithChoices(p.unitPriceCents, choices),
    unitLabel: p.unitLabel,
    taxable: p.taxable,
    choiceIds: choices.map((c) => c.id),
  };
};

/**
 * The catalogue, picked from. A floating card under the button on a desk, a bottom sheet on a phone — the same
 * list either way, with a last row that takes whatever was typed as a one-off line so a price nobody has entered
 * yet never blocks a quote.
 */
export function ProductPicker({
  products,
  open,
  onClose,
  onPick,
  className,
}: {
  products: readonly ProductRow[];
  open: boolean;
  onClose: () => void;
  onPick: (product: PickedProduct) => void;
  className?: string;
}) {
  const [q, setQ] = useState('');
  /** A product with sizes or colors, while one of each is being picked for it. */
  const [choosing, setChoosing] = useState<ProductRow | null>(null);
  const [picks, setPicks] = useState<OptionPicks>({});
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setQ('');
      setChoosing(null);
      setPicks({});
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const live = products.filter((p) => !p.archivedAt);
    if (!needle) return live.slice(0, 40);
    return live
      .filter((p) =>
        `${p.name} ${p.sku ?? ''} ${p.description ?? ''}`.toLowerCase().includes(needle),
      )
      .slice(0, 40);
  }, [products, q]);

  if (!open) return null;

  return (
    <>
      {/* The phone's scrim. The card itself is the sheet at that width. */}
      <div className="fixed inset-0 z-40 bg-[var(--scrim)] sm:hidden" aria-hidden />
      <div
        ref={box}
        role="dialog"
        aria-label="Add from the catalogue"
        data-testid="product-picker"
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[76vh] flex-col rounded-t-2xl border-t border-border bg-card p-2 shadow-3',
          'sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:z-40 sm:mt-1.5 sm:w-[360px] sm:max-h-[360px] sm:rounded-card sm:border sm:shadow-2',
          className,
        )}
      >
        <div className="flex items-center gap-2 px-1 pb-2 pt-1 sm:hidden">
          <span className="flex-1 text-[15px] font-semibold">Catalogue</span>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </div>
        {choosing ? (
          <ChoicePicker
            product={choosing}
            picks={picks}
            onPicks={setPicks}
            onBack={() => {
              setChoosing(null);
              setPicks({});
            }}
            onAdd={() => {
              onPick(pick(choosing, picks));
              onClose();
            }}
          />
        ) : (
          <>
            <div className="relative mb-1.5 px-0.5">
              <Search
                className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-text-3"
                strokeWidth={1.5}
              />
              <Input
                inputSize="sm"
                className="pl-9"
                autoFocus
                placeholder="Search the catalogue"
                value={q}
                autoComplete="off"
                onChange={(e) => setQ(e.target.value)}
                data-testid="product-picker-search"
              />
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto" role="listbox">
              {matches.length === 0 ? (
                <li className="px-2.5 py-3 text-[13px] text-text-3">
                  {products.length
                    ? 'Nothing in the catalogue matches.'
                    : 'The catalogue is empty. Add a line by hand, or add products in Settings → Products.'}
                </li>
              ) : null}
              {matches.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      if (productHasOptions(p)) {
                        setChoosing(p);
                        setPicks({});
                        return;
                      }
                      onPick(pick(p));
                      onClose();
                    }}
                    data-testid={`product-option-${p.name}`}
                    className="flex w-full items-center gap-2.5 rounded-[6px] px-2 py-2 text-left hover:bg-card-2 max-md:min-h-11"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
                      <span className="truncate text-xs text-text-3">
                        {[
                          p.sku,
                          p.options.length
                            ? `pick ${p.options.map((o) => o.name).join(', ')}`
                            : null,
                          p.taxable ? 'taxable' : 'no tax',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="flex flex-none flex-col items-end">
                      <span className="text-[13px] font-semibold tabular-nums">
                        {money(p.unitPriceCents)}
                      </span>
                      <span className="text-xs text-text-3">{p.unitLabel}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-1 border-t border-border pt-1">
              <button
                type="button"
                onClick={() => {
                  onPick(blankLine(q));
                  onClose();
                }}
                data-testid="product-picker-freehand"
                className="flex w-full items-center gap-2 rounded-[6px] px-2 py-2 text-left text-[13px] font-medium text-accent-text hover:bg-card-2 max-md:min-h-11"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                {q.trim() ? `A one-off line “${q.trim()}”` : 'A line of your own'}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * One choice of each of a product's options (Size, Color), before it goes on as a line. Nothing is picked for them:
 * a T-shirt added in the wrong size is worse than a tap.
 */
function ChoicePicker({
  product,
  picks,
  onPicks,
  onBack,
  onAdd,
}: {
  product: ProductRow;
  picks: OptionPicks;
  onPicks: (picks: OptionPicks) => void;
  onBack: () => void;
  onAdd: () => void;
}) {
  const { choices, missing } = pickedChoices(product, picks);
  const price = priceWithChoices(product.unitPriceCents, choices);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="product-choices">
      <div className="flex items-center gap-1.5 px-0.5 pb-2">
        <Button variant="ghost" size="icon" aria-label="Back to the catalogue" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
        </Button>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{product.name}</span>
        <span className="text-[13px] font-semibold tabular-nums">{money(price)}</span>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-1.5 pb-2">
        {product.options.map((o) => (
          <div key={o.id} role="radiogroup" aria-label={o.name}>
            <span className="mb-1.5 block text-[12.5px] font-medium text-text-2">{o.name}</span>
            <div className="flex flex-wrap gap-1.5">
              {o.choices.map((c) => {
                const on = picks[o.id] === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => onPicks({ ...picks, [o.id]: c.id })}
                    data-testid={`product-choice-${c.label}`}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[13px] transition-colors max-md:min-h-9',
                      on
                        ? 'border-accent bg-accent-soft font-medium text-accent-text'
                        : 'border-border hover:bg-card-2',
                    )}
                  >
                    {c.label}
                    {c.priceCents ? (
                      <span className="ml-1 text-xs text-text-3">
                        {choiceBumpWords(c.priceCents)}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-1 pt-2">
        <Button
          size="sm"
          className="w-full"
          disabled={missing.length > 0}
          onClick={onAdd}
          data-testid="product-choices-add"
        >
          {missing.length
            ? `Pick a ${missing[0]!.name.toLowerCase()}`
            : `Add ${nameWithChoices(product.name, choices)}`}
        </Button>
      </div>
    </div>
  );
}
