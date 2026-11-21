'use client';
/**
 * A product's sizes, colors and other choices, in Settings → Payments → Products (core's money/options.ts): up to
 * three options, each with its choices and what each one adds to the price ("Adult 2XL +$2"), or takes off ("Youth
 * S −$1"). Picking the product on an estimate, an invoice or a form then means picking one of each.
 *
 * A choice keeps its id when it's renamed, so a form's rows made from it still find it.
 */
import {
  choiceBumpWords,
  MAX_OPTION_CHOICES,
  MAX_PRODUCT_OPTIONS,
  money,
  newOptionChoiceId,
  newOptionId,
  OPTION_STARTERS,
  parseMoneyChange,
  priceWithChoices,
} from '@hfos/core';
import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface ChoiceDraft {
  readonly id: string;
  readonly label: string;
  readonly priceCents: number;
}
export interface OptionDraft {
  readonly id: string;
  readonly name: string;
  readonly choices: readonly ChoiceDraft[];
}

const newChoice = (label = ''): ChoiceDraft => ({ id: newOptionChoiceId(), label, priceCents: 0 });

/** Whether every option and choice has a name and every price change reads as one. */
export function optionDraftsReady(options: readonly OptionDraft[], badPrices: number): boolean {
  return (
    badPrices === 0 &&
    options.every(
      (o) => o.name.trim() && o.choices.length && o.choices.every((c) => c.label.trim()),
    )
  );
}

export function ProductOptionsEditor({
  options,
  basePriceCents,
  onChange,
  onBadPrices,
}: {
  options: readonly OptionDraft[];
  /** The product's own price, so each choice shows what it comes to. */
  basePriceCents: number;
  onChange: (options: readonly OptionDraft[]) => void;
  /** How many price changes can't be read, so the editor can hold Save. */
  onBadPrices: (count: number) => void;
}) {
  const [bad, setBad] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => onBadPrices(bad.size), [bad, onBadPrices]);
  const markBad = (id: string, isBad: boolean) =>
    setBad((was) => {
      if (was.has(id) === isBad) return was;
      const next = new Set(was);
      if (isBad) next.add(id);
      else next.delete(id);
      return next;
    });

  const setOption = (id: string, patch: Partial<OptionDraft>) =>
    onChange(options.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const setChoice = (optionId: string, choiceId: string, patch: Partial<ChoiceDraft>) =>
    onChange(
      options.map((o) =>
        o.id === optionId
          ? { ...o, choices: o.choices.map((c) => (c.id === choiceId ? { ...c, ...patch } : c)) }
          : o,
      ),
    );
  const removeOption = (o: OptionDraft) => {
    for (const c of o.choices) markBad(c.id, false);
    onChange(options.filter((x) => x.id !== o.id));
  };
  const addOption = (name: string, labels: readonly string[]) =>
    onChange([
      ...options,
      {
        id: newOptionId(),
        name,
        choices: labels.length ? labels.map((l) => newChoice(l)) : [newChoice()],
      },
    ]);
  const full = options.length >= MAX_PRODUCT_OPTIONS;

  return (
    <div className="space-y-3" data-testid="product-options">
      <div>
        <span className="block text-[13px] font-medium">Sizes, colors and other choices</span>
        <span className="block text-xs text-text-3">
          Picking it on an estimate, an invoice or a form then means picking one of each. Leave the
          price change empty when a choice costs the same.
        </span>
      </div>

      {options.map((o, i) => (
        <div
          key={o.id}
          className="@container space-y-2 rounded-control border border-border p-3"
          data-testid={`product-option-${i}`}
        >
          <div className="flex items-center gap-2">
            <Input
              inputSize="sm"
              aria-label="Option name"
              placeholder="Size, Color, Style…"
              value={o.name}
              maxLength={40}
              onChange={(e) => setOption(o.id, { name: e.target.value })}
              data-testid="product-option-name"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${o.name || 'this option'}`}
              onClick={() => removeOption(o)}
            >
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          </div>
          <ul className="space-y-2.5 @xs:space-y-1.5">
            {o.choices.map((c) => (
              <li
                key={c.id}
                className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @xs:grid-cols-[minmax(0,1fr)_84px_3.5rem_auto] @xs:gap-y-0"
                data-testid="product-choice"
              >
                <Input
                  inputSize="sm"
                  className="col-span-2 @xs:col-span-1"
                  aria-label={`Choice of ${o.name || 'this option'}`}
                  placeholder="Adult M"
                  value={c.label}
                  maxLength={60}
                  onChange={(e) => setChoice(o.id, c.id, { label: e.target.value })}
                  data-testid="product-choice-label"
                />
                <ChangeInput
                  cents={c.priceCents}
                  label={`Price change for ${c.label || 'this choice'}`}
                  onChange={(priceCents) => setChoice(o.id, c.id, { priceCents })}
                  onBad={(isBad) => markBad(c.id, isBad)}
                />
                <span
                  className="order-3 text-[12.5px] tabular-nums text-text-3 @xs:order-none @xs:text-right"
                  aria-label={`${c.label} costs`}
                >
                  {money(priceWithChoices(basePriceCents, [c]))}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="order-1 @xs:order-none"
                  aria-label={`Remove ${c.label || 'this choice'}`}
                  disabled={o.choices.length <= 1}
                  onClick={() => {
                    markBad(c.id, false);
                    setOption(o.id, { choices: o.choices.filter((x) => x.id !== c.id) });
                  }}
                >
                  <X className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            disabled={o.choices.length >= MAX_OPTION_CHOICES}
            onClick={() => setOption(o.id, { choices: [...o.choices, newChoice()] })}
            data-testid="product-choice-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add a choice
          </Button>
        </div>
      ))}

      {!full ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => addOption('', [])}
            data-testid="product-option-add"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            Add an option
          </Button>
          <span className="text-xs text-text-3">or start from</span>
          {OPTION_STARTERS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="rounded-full border border-border px-2.5 py-1 text-[12.5px] font-medium hover:bg-card-2 max-md:min-h-9"
              onClick={() => addOption(s.name, s.choices)}
              data-testid={`product-option-starter-${s.key}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-3">A product has up to {MAX_PRODUCT_OPTIONS} options.</p>
      )}
    </div>
  );
}

/** "+$2", "−$1.50" or empty, typed as the person likes: "2", "+2", "-1.50". */
function ChangeInput({
  cents,
  label,
  onChange,
  onBad,
}: {
  cents: number;
  label: string;
  onChange: (cents: number) => void;
  onBad: (bad: boolean) => void;
}) {
  const [text, setText] = useState(() => choiceBumpWords(cents));
  const parsed = parseMoneyChange(text);
  return (
    <Input
      inputSize="sm"
      className={cn(
        'order-2 w-full tabular-nums @xs:order-none',
        parsed === null && 'border-danger focus-visible:ring-danger',
      )}
      aria-label={label}
      aria-invalid={parsed === null}
      placeholder="+$0"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const next = parseMoneyChange(e.target.value);
        onBad(next === null);
        if (next !== null) onChange(next);
      }}
      onBlur={() => {
        if (parsed !== null) setText(choiceBumpWords(parsed));
      }}
      data-testid="product-choice-price"
    />
  );
}
