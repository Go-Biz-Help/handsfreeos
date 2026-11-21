'use client';
/**
 * A "How many of each" question's settings (core's forms/quantities.ts): its rows, each with an optional price, the
 * rows it can take straight from the price list (Settings → Payments → Products), and what the total counts and is
 * held to.
 *
 * A row from the price list keeps its own copy of the name and price, as an invoice's line does, so repricing a
 * product never quietly reprices a live form. When the two have drifted apart the row says so and offers the price
 * list's.
 */
import {
  MAX_QUANTITY_ROWS,
  money,
  parseMoney,
  quantityRowsOf,
  rowPriceCents,
  type FormOp,
  type Question,
  type QuantityRow,
} from '@hfos/core';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Hint, Label } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import type { FormCatalogsOut } from '@/lib/api/types';
import { newChoice } from './editor-state';
import { RequiredInput } from './required-text';

type Product = FormCatalogsOut['products'][number];

export function QuantitiesSettings({
  workspaceId,
  question,
  questionId,
  apply,
  catalogs,
  readOnly,
}: {
  workspaceId: string;
  question: Question;
  questionId: string;
  apply: (ops: FormOp[]) => void;
  catalogs: FormCatalogsOut | null;
  readOnly: boolean;
}) {
  const rows = quantityRowsOf(question);
  const config = question.config as {
    unit: string;
    minTotal: number | null;
    maxTotal: number | null;
    showPrices: boolean;
  };
  const patchRow = (id: string, fields: Partial<QuantityRow>) =>
    apply([
      {
        op: 'update_question',
        questionId,
        patch: { config: { choices: [{ id, ...fields }] } },
      },
    ]);
  const patchConfig = (fields: Record<string, unknown>) =>
    apply([{ op: 'update_question', questionId, patch: { config: fields } }]);

  const products = catalogs?.products ?? [];
  const productOf = (row: QuantityRow): Product | undefined =>
    row.productId ? products.find((p) => p.id === row.productId) : undefined;
  const onTheForm = new Set(rows.map((r) => r.productId).filter(Boolean));
  const notYetAdded = products.filter((p) => !onTheForm.has(p.id));
  const full = rows.length >= MAX_QUANTITY_ROWS;

  const addProducts = (list: readonly Product[]) => {
    const room = MAX_QUANTITY_ROWS - rows.length;
    apply(
      list.slice(0, room).map((p) => ({
        op: 'add_choice' as const,
        questionId,
        index: null,
        choice: { ...newChoice(p.name), price: p.priceCents / 100, productId: p.id },
      })),
    );
  };

  return (
    <>
      <Card className="space-y-3 p-4" data-testid="quantity-rows">
        <div>
          <Label>The rows</Label>
          <Hint>
            Sizes, flavors, colors or products. Each gets a box for how many. Leave the price empty
            to only count it.
          </Hint>
        </div>
        {rows.map((row) => {
          const product = productOf(row);
          const drifted = product && product.priceCents !== rowPriceCents(row);
          return (
            <div key={row.id} className="space-y-1">
              <div className="flex items-center gap-2">
                <RequiredInput
                  holdKey={row.id}
                  value={row.label}
                  disabled={readOnly}
                  aria-label="Row"
                  onSave={(label) => patchRow(row.id, { label })}
                />
                <PriceInput
                  cents={rowPriceCents(row)}
                  disabled={readOnly}
                  label={`Price of one ${row.label}`}
                  onSave={(cents) =>
                    patchRow(row.id, { price: cents === null ? null : cents / 100 })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove row"
                  disabled={readOnly || rows.length <= 1}
                  onClick={() => apply([{ op: 'delete_choice', questionId, choiceId: row.id }])}
                >
                  <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                </Button>
              </div>
              {row.productId ? (
                <p className="text-[12px] text-text-3">
                  {product ? (
                    <>
                      From your price list
                      {drifted ? (
                        <>
                          , which now says {money(product.priceCents)}.{' '}
                          {!readOnly ? (
                            <button
                              type="button"
                              className="font-medium text-accent-text underline-offset-2 hover:underline"
                              onClick={() => patchRow(row.id, { price: product.priceCents / 100 })}
                            >
                              Use that price
                            </button>
                          ) : null}
                        </>
                      ) : (
                        '.'
                      )}
                    </>
                  ) : (
                    'No longer on your price list. The form keeps this name and price.'
                  )}
                </p>
              ) : null}
            </div>
          );
        })}
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={full}
              onClick={() =>
                apply([
                  {
                    op: 'add_choice',
                    questionId,
                    index: null,
                    choice: newChoice(`Row ${rows.length + 1}`),
                  },
                ])
              }
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add a row
            </Button>
            {notYetAdded.length ? (
              <>
                <Select
                  selectSize="sm"
                  className="w-auto max-w-[16rem]"
                  aria-label="Add from your products"
                  value=""
                  disabled={full}
                  onChange={(e) => {
                    const picked = notYetAdded.find((p) => p.id === e.target.value);
                    if (picked) addProducts([picked]);
                  }}
                  data-testid="quantity-add-product"
                >
                  <option value="">Add from your products…</option>
                  {notYetAdded.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {money(p.priceCents)}
                    </option>
                  ))}
                </Select>
                {notYetAdded.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={full}
                    onClick={() => addProducts(notYetAdded)}
                  >
                    Add all {notYetAdded.length}
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {catalogs && !products.length && !readOnly ? (
          <Hint>
            Sell the same things often? Add them in{' '}
            <Link
              className="font-medium text-accent-text underline-offset-2 hover:underline"
              href={`/app/w/${workspaceId}/settings/payments/products`}
            >
              Settings → Payments → Products
            </Link>{' '}
            and pick them here with their prices.
          </Hint>
        ) : null}
        {full ? <Hint>A question holds up to {MAX_QUANTITY_ROWS} rows.</Hint> : null}
      </Card>

      <Card className="grid gap-3 p-4 sm:grid-cols-3" data-testid="quantity-totals">
        <Field
          label="What it counts"
          htmlFor="q-quantity-unit"
          hint="Under the boxes: 24 shirts."
          className="sm:col-span-3"
        >
          <Input
            id="q-quantity-unit"
            value={config.unit ?? ''}
            placeholder="shirts"
            maxLength={24}
            disabled={readOnly}
            onChange={(e) => patchConfig({ unit: e.target.value })}
          />
        </Field>
        <Field label="Least in all" htmlFor="q-quantity-min" hint="A minimum order.">
          <Input
            id="q-quantity-min"
            type="number"
            min={1}
            value={config.minTotal ?? ''}
            disabled={readOnly}
            onChange={(e) =>
              patchConfig({ minTotal: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </Field>
        <Field label="Most in all" htmlFor="q-quantity-max">
          <Input
            id="q-quantity-max"
            type="number"
            min={1}
            value={config.maxTotal ?? ''}
            disabled={readOnly}
            onChange={(e) =>
              patchConfig({ maxTotal: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </Field>
        <div className="flex items-center justify-between gap-4 sm:col-span-3">
          <div>
            <Label htmlFor="q-quantity-prices">Show prices</Label>
            <Hint>Each row’s price, and what the order comes to under the boxes.</Hint>
          </div>
          <Switch
            label="Show prices"
            checked={config.showPrices !== false}
            disabled={readOnly}
            onChange={(on) => patchConfig({ showPrices: on })}
            testId="question-quantity-prices"
          />
        </div>
      </Card>
    </>
  );
}

/** One row's price in dollars: empty is no price, and what isn't an amount stays red until it's fixed. */
function PriceInput({
  cents,
  disabled,
  label,
  onSave,
}: {
  cents: number | null;
  disabled: boolean;
  label: string;
  onSave: (cents: number | null) => void;
}) {
  const [text, setText] = useState(cents === null ? '' : money(cents));
  const [typing, setTyping] = useState(false);
  // A price changed elsewhere (Use that price, Undo) shows up here unless it's being typed.
  useEffect(() => {
    if (!typing) setText(cents === null ? '' : money(cents));
  }, [cents, typing]);
  const parsed = text.trim() === '' ? null : parseMoney(text);
  const invalid = text.trim() !== '' && parsed === null;
  return (
    <Input
      className="w-28 shrink-0 text-right tabular-nums"
      inputMode="decimal"
      autoComplete="off"
      placeholder="No price"
      aria-label={label}
      value={text}
      invalid={invalid}
      disabled={disabled}
      onFocus={() => setTyping(true)}
      onChange={(e) => {
        setText(e.target.value);
        const next = e.target.value.trim() === '' ? null : parseMoney(e.target.value);
        if (e.target.value.trim() === '' || next !== null) onSave(next);
      }}
      onBlur={() => {
        setTyping(false);
        if (!invalid) setText(parsed === null ? '' : money(parsed));
      }}
    />
  );
}
