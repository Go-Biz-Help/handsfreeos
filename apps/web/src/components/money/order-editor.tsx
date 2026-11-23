'use client';
import {
  MAX_ORDER_LINES,
  MAX_ORDER_NOTES,
  MAX_ORDER_QUANTITY,
  money,
  orderItemCount,
  orderTotalCents,
  type OrderFulfilment,
} from '@hfos/core';
import { Boxes, Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Textarea } from '@/components/ui/textarea';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { ProductRow } from '@/lib/api/types';
import { MoneyInput } from './money-input';
import { PersonPicker, type PickedPerson } from './person-picker';
import { blankLine, ProductPicker, type PickedProduct } from './product-picker';

/** One line while it's being written. */
export interface OrderLineDraft {
  readonly key: string;
  readonly productId: string | null;
  readonly choiceIds: readonly string[];
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly taxable: boolean;
}

let seq = 0;
const nextKey = () => `l${++seq}`;

export const draftLine = (l: Omit<OrderLineDraft, 'key'>): OrderLineDraft => ({
  ...l,
  key: nextKey(),
});

const fromPicked = (p: PickedProduct): OrderLineDraft =>
  draftLine({
    productId: p.productId,
    choiceIds: [...p.choiceIds],
    name: p.name,
    quantity: 1,
    unitPriceCents: p.unitPriceCents,
    taxable: p.taxable,
  });

/** The lines as the order commands take them. */
export const linesInput = (lines: readonly OrderLineDraft[]) =>
  lines.map((l) => ({
    productId: l.productId,
    choiceIds: [...l.choiceIds],
    name: l.name.trim(),
    quantity: l.quantity,
    unitPriceCents: l.unitPriceCents,
    taxable: l.taxable,
  }));

/** What stops these lines being saved, in a sentence, or null. */
export function linesProblem(lines: readonly OrderLineDraft[], badPrice: boolean): string | null {
  if (!lines.length) return 'Add at least one thing to the order.';
  if (lines.some((l) => !l.name.trim())) return 'Name each thing on the order.';
  if (lines.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1))
    return 'Order at least one of each line, or take the line off.';
  if (badPrice) return 'Fix the price marked in red.';
  return null;
}

/**
 * What's on an order: each thing with how many and the price, from the price list (with its size or color) or
 * typed in, and the total under them.
 */
export function OrderLinesEditor({
  lines,
  onChange,
  products,
  onBadPrice,
}: {
  lines: readonly OrderLineDraft[];
  onChange: (lines: OrderLineDraft[]) => void;
  products: readonly ProductRow[];
  onBadPrice: (bad: boolean) => void;
}) {
  const [picker, setPicker] = useState(false);
  // Which lines' price boxes hold something that isn't a price, so the parent can hold Save back.
  const bad = useRef<Record<string, boolean>>({});
  const set = (key: string, patch: Partial<OrderLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const markBad = (key: string, invalid: boolean) => {
    if (!!bad.current[key] === invalid) return;
    bad.current = { ...bad.current, [key]: invalid };
    onBadPrice(Object.values(bad.current).some(Boolean));
  };
  const remove = (key: string) => {
    markBad(key, false);
    onChange(lines.filter((l) => l.key !== key));
  };
  const full = lines.length >= MAX_ORDER_LINES;

  return (
    <div data-testid="order-lines">
      {lines.length ? (
        <ul className="divide-y divide-border rounded-card border border-border">
          {lines.map((l) => (
            <li
              key={l.key}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 p-3 sm:grid-cols-[minmax(0,1fr)_88px_112px_auto]"
              data-testid="order-line"
            >
              <Input
                aria-label="What"
                value={l.name}
                maxLength={200}
                placeholder="What they ordered"
                onChange={(e) => set(l.key, { name: e.target.value })}
                className="col-span-2 sm:col-span-1"
                data-testid="order-line-name"
              />
              <span className="flex items-center gap-1.5 sm:contents">
                <span className="text-[12.5px] text-text-3 sm:hidden">How many</span>
                <Input
                  aria-label="How many"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_ORDER_QUANTITY}
                  step={1}
                  value={Number.isFinite(l.quantity) ? String(l.quantity) : ''}
                  invalid={!Number.isInteger(l.quantity) || l.quantity < 1}
                  onChange={(e) => set(l.key, { quantity: Math.trunc(Number(e.target.value)) })}
                  className="w-20 text-right tabular-nums sm:w-full"
                  data-testid="order-line-qty"
                />
              </span>
              <span className="flex items-center justify-end gap-1.5 sm:contents">
                <MoneyInput
                  aria-label="Price each"
                  valueCents={l.unitPriceCents}
                  onChange={(cents) => set(l.key, { unitPriceCents: cents })}
                  onInvalid={(invalid) => markBad(l.key, invalid === true)}
                  className="w-28 sm:w-full"
                  data-testid="order-line-price"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Take ${l.name || 'this line'} off`}
                  onClick={() => remove(l.key)}
                  data-testid="order-line-remove"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-[13px] text-text-3">
          Nothing on it yet. Add something from your price list, or type a line.
        </p>
      )}

      <div className="relative mt-3 flex flex-wrap items-center gap-2">
        <span className="relative max-md:flex-1">
          <Button
            variant="secondary"
            size="sm"
            className="max-md:h-11 max-md:w-full"
            disabled={full}
            onClick={() => setPicker((p) => !p)}
            data-testid="order-line-catalogue"
          >
            <Boxes className="h-4 w-4" strokeWidth={1.5} />
            Add from the price list
          </Button>
          <ProductPicker
            products={products}
            open={picker}
            onClose={() => setPicker(false)}
            onPick={(p) => {
              setPicker(false);
              onChange([...lines, fromPicked(p)]);
            }}
          />
        </span>
        <Button
          variant="secondary"
          size="sm"
          className="max-md:h-11 max-md:flex-1"
          disabled={full}
          onClick={() => onChange([...lines, fromPicked({ ...blankLine(''), name: '' })])}
          data-testid="order-line-add"
        >
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          Type a line
        </Button>
        <span className="flex-1" />
        <span className="text-[13.5px] text-text-2" data-testid="order-lines-total">
          {orderItemCount(lines).toLocaleString('en-US')}{' '}
          {orderItemCount(lines) === 1 ? 'item' : 'items'} ·{' '}
          <span className="font-semibold text-text">{money(orderTotalCents(lines))}</span>
        </span>
      </div>
    </div>
  );
}

/** Pickup or delivery, and the day. */
export function OrderWhenFields({
  fulfilment,
  dueOn,
  onFulfilment,
  onDueOn,
  disabled,
}: {
  fulfilment: OrderFulfilment | null;
  dueOn: string;
  onFulfilment: (f: OrderFulfilment | null) => void;
  onDueOn: (day: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <span className="mb-1.5 block text-[13px] font-medium text-text-2">Pickup or delivery</span>
        <span className="flex items-center gap-1">
          <Segmented<OrderFulfilment | 'none'>
            value={fulfilment ?? 'none'}
            onChange={(v) => !disabled && onFulfilment(v === 'none' ? null : v)}
            ariaLabel="Pickup or delivery"
            options={[
              { value: 'pickup', label: 'Pickup', testId: 'order-pickup' },
              { value: 'delivery', label: 'Delivery', testId: 'order-delivery' },
              { value: 'none', label: 'Not sure yet', testId: 'order-fulfilment-none' },
            ]}
          />
        </span>
      </div>
      <Field label="On what day" htmlFor="order-due" className="w-[180px]">
        <span className="flex items-center gap-1">
          <Input
            id="order-due"
            type="date"
            value={dueOn}
            disabled={disabled}
            onChange={(e) => onDueOn(e.target.value)}
            data-testid="order-due"
          />
          {dueOn && !disabled ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear the day"
              onClick={() => onDueOn('')}
            >
              <X className="h-4 w-4" strokeWidth={1.75} />
            </Button>
          ) : null}
        </span>
      </Field>
    </div>
  );
}

/** New order on Money → Orders: who it's for, what they want, pickup or delivery and the day, and notes. */
export function NewOrderEditor({
  workspaceId,
  products,
  person: seeded,
}: {
  workspaceId: string;
  products: readonly ProductRow[];
  person: PickedPerson | null;
}) {
  const router = useRouter();
  const [person, setPerson] = useState<PickedPerson | null>(seeded);
  const [lines, setLines] = useState<OrderLineDraft[]>([]);
  const [badPrice, setBadPrice] = useState(false);
  const [fulfilment, setFulfilment] = useState<OrderFulfilment | null>(null);
  const [dueOn, setDueOn] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = !person ? 'Pick who the order is for.' : linesProblem(lines, badPrice);

  async function save() {
    if (problem || !person) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/commands/order.create', {
          body: {
            workspaceId,
            personId: person.id,
            lines: linesInput(lines),
            fulfilment,
            dueOn: dueOn || null,
            notes: notes.trim() || null,
          },
        }),
      );
      toast.success(`Order #${out.number} saved.`);
      router.push(`/app/w/${workspaceId}/money/orders/${out.orderId}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[860px] space-y-4" data-testid="order-editor">
      <h1 className="text-[22px] font-semibold tracking-tight">New order</h1>
      <Card className="px-5 pb-5 pt-4">
        <h2 className="mb-2 text-base font-semibold tracking-tight">Who it’s for</h2>
        {person ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[14px] font-medium" data-testid="order-person">
              {person.fullName}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setPerson(null)}>
              Change
            </Button>
          </div>
        ) : (
          <PersonPicker workspaceId={workspaceId} onPick={setPerson} autoFocus id="order-person" />
        )}
      </Card>

      <Card className="px-5 pb-5 pt-4">
        <h2 className="mb-3 text-base font-semibold tracking-tight">What they want</h2>
        <OrderLinesEditor
          lines={lines}
          onChange={setLines}
          products={products}
          onBadPrice={setBadPrice}
        />
      </Card>

      <Card className="space-y-4 px-5 pb-5 pt-4">
        <OrderWhenFields
          fulfilment={fulfilment}
          dueOn={dueOn}
          onFulfilment={setFulfilment}
          onDueOn={setDueOn}
        />
        <Field label="Notes" htmlFor="order-notes" hint="Only your team sees these.">
          <Textarea
            id="order-notes"
            rows={3}
            value={notes}
            maxLength={MAX_ORDER_NOTES}
            placeholder="Colors, names to print, anything to remember"
            onChange={(e) => setNotes(e.target.value)}
            data-testid="order-notes"
          />
        </Field>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        {problem && (person || lines.length) ? (
          <span className="text-[13px] text-text-3">{problem}</span>
        ) : null}
        <Button
          variant="secondary"
          onClick={() => router.push(`/app/w/${workspaceId}/money/orders`)}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button onClick={save} loading={busy} disabled={!!problem} data-testid="order-save">
          Save the order
        </Button>
      </div>
    </div>
  );
}
