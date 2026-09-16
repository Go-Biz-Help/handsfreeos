'use client';
import { lineSubtotalCents, money } from '@hfos/core';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import type { DraftLine } from './draft';
import { MoneyInput, QuantityInput } from './money-input';

const UNITS = ['each', 'hour', 'day', 'visit', 'job', 'ft', 'sq ft', 'unit'];

/**
 * One line, full size, on a phone: the same fields the desk shows in a row, stacked, with 44 px controls. It
 * edits a copy and hands it back on Done, so a half-typed price never lands in the totals.
 */
export function LineSheet({
  line,
  taxed,
  onSave,
  onRemove,
  onClose,
}: {
  line: DraftLine | null;
  /** The business charges sales tax, so "Taxable" is worth a switch. */
  taxed: boolean;
  onSave: (line: DraftLine) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={line !== null} onOpenChange={(open) => !open && onClose()}>
      {line ? (
        <LineFields
          key={line.key}
          line={line}
          taxed={taxed}
          onSave={onSave}
          onRemove={onRemove}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}

function LineFields({
  line,
  taxed,
  onSave,
  onRemove,
  onClose,
}: {
  line: DraftLine;
  taxed: boolean;
  onSave: (line: DraftLine) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<DraftLine>(line);
  const set = (patch: Partial<DraftLine>) => setDraft((d) => ({ ...d, ...patch }));
  const amount = lineSubtotalCents(draft);

  return (
    <SheetContent
      title={draft.name.trim() || 'This line'}
      description="What it is and what it costs."
    >
      <div className="mt-4 flex flex-col gap-3.5" data-testid="line-sheet">
        <Field label="What it is" htmlFor="line-name">
          <Input
            id="line-name"
            value={draft.name}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field
          label="Description"
          htmlFor="line-description"
          hint="The customer sees this under the line."
        >
          <Textarea
            id="line-description"
            rows={2}
            value={draft.description}
            maxLength={2_000}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="How many" htmlFor="line-quantity">
            <QuantityInput
              id="line-quantity"
              value={draft.quantity}
              onChange={(quantity) => set({ quantity })}
            />
          </Field>
          <Field label="Per" htmlFor="line-unit">
            <Input
              id="line-unit"
              list="money-units"
              value={draft.unitLabel}
              maxLength={40}
              autoComplete="off"
              onChange={(e) => set({ unitLabel: e.target.value })}
            />
            <datalist id="money-units">
              {UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price" htmlFor="line-price">
            <MoneyInput
              id="line-price"
              valueCents={draft.unitPriceCents}
              onChange={(unitPriceCents) => set({ unitPriceCents })}
            />
          </Field>
          <Field label="Money off this line" htmlFor="line-discount">
            <MoneyInput
              id="line-discount"
              valueCents={draft.discountCents}
              onChange={(discountCents) => set({ discountCents })}
            />
          </Field>
        </div>
        {taxed ? (
          <label className="flex items-center justify-between gap-3 border-t border-border pt-3.5 text-[13px] font-medium">
            Sales tax applies to this line
            <Switch
              checked={draft.taxable}
              label="Sales tax applies to this line"
              onChange={(taxable) => set({ taxable })}
              testId="line-taxable"
            />
          </label>
        ) : null}
        <div className="flex items-center justify-between border-t border-border pt-3.5 text-[15px] font-semibold">
          Amount
          <span className="tabular-nums">{money(amount)}</span>
        </div>
      </div>
      <div className="mt-5 flex items-center gap-2">
        <Button
          variant="ghost"
          size="lg"
          onClick={onRemove}
          aria-label="Remove this line"
          data-testid="line-remove"
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.5} />
          Remove
        </Button>
        <span className="flex-1" />
        <Button variant="secondary" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="lg"
          disabled={!draft.name.trim() || !(draft.quantity > 0)}
          onClick={() => onSave(draft)}
          data-testid="line-done"
        >
          Done
        </Button>
      </div>
    </SheetContent>
  );
}
