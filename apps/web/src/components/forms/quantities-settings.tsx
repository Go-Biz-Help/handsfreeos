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
  priceListCents,
  priceWithChoices,
  quantityRowsOf,
  rowPriceCents,
  rowsFromOption,
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

/**
 * What "Add from your products…" offers: a product as one row, or a product with sizes or colors as one row per
 * choice of one of its options ("T-shirt, a row per size"), each at its own price.
 */
interface Offer {
  readonly key: string;
  readonly label: string;
  readonly product: Product;
  readonly option: Product['options'][number] | null;
}

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
    makesOrder?: boolean;
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
  const plainOnForm = new Set(rows.filter((r) => !r.optionChoiceId).map((r) => r.productId));
  const choicesOnForm = new Set(rows.map((r) => r.optionChoiceId).filter(Boolean));
  const offers: Offer[] = products.flatMap((p): Offer[] =>
    p.options.length
      ? p.options.map((o) => ({
          key: `${p.id}:${o.id}`,
          label: `${p.name}, a row per ${o.name.toLowerCase()} · from ${money(
            Math.min(...o.choices.map((c) => priceWithChoices(p.priceCents, [c]))),
          )}`,
          product: p,
          option: o,
        }))
      : [{ key: p.id, label: `${p.name} · ${money(p.priceCents)}`, product: p, option: null }],
  );
  const notYetAdded = offers.filter((o) =>
    o.option
      ? o.option.choices.some((c) => !choicesOnForm.has(c.id))
      : !plainOnForm.has(o.product.id),
  );
  const plainLeft = notYetAdded.filter((o) => !o.option);
  const full = rows.length >= MAX_QUANTITY_ROWS;

  const addOffers = (list: readonly Offer[]) => {
    const fresh = list.flatMap((o) =>
      o.option
        ? rowsFromOption(o.product, o.option).filter((r) => !choicesOnForm.has(r.optionChoiceId))
        : [{ label: o.product.name, price: o.product.priceCents / 100, productId: o.product.id }],
    );
    apply(
      fresh.slice(0, MAX_QUANTITY_ROWS - rows.length).map((fields) => ({
        op: 'add_choice' as const,
        questionId,
        index: null,
        choice: { ...newChoice(fields.label), ...fields },
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
          // What the price list says this row costs now: the product's price, with its size's bump.
          const listCents = product ? priceListCents(row, product) : null;
          const drifted = listCents !== null && listCents !== rowPriceCents(row);
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
                  {product && listCents === null ? (
                    `That choice is no longer on ${product.name}. The form keeps this name and price.`
                  ) : product && listCents !== null ? (
                    <>
                      From your price list
                      {drifted ? (
                        <>
                          , which now says {money(listCents)}.{' '}
                          {!readOnly ? (
                            <button
                              type="button"
                              className="font-medium text-accent-text underline-offset-2 hover:underline"
                              onClick={() => patchRow(row.id, { price: listCents / 100 })}
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
                    const picked = notYetAdded.find((o) => o.key === e.target.value);
                    if (picked) addOffers([picked]);
                  }}
                  data-testid="quantity-add-product"
                >
                  <option value="">Add from your products…</option>
                  {notYetAdded.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {plainLeft.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={full}
                    onClick={() => addOffers(plainLeft)}
                  >
                    Add all {plainLeft.length}
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
        <div className="flex items-center justify-between gap-4 sm:col-span-3">
          <div>
            <Label htmlFor="q-quantity-order">Makes an order</Label>
            <Hint>
              When it’s sent, what they ordered goes on Money → Orders, with the day and pickup or
              delivery if the form asks. Turn it off for a head count that isn’t an order.
            </Hint>
          </div>
          <Switch
            label="Makes an order"
            checked={config.makesOrder !== false}
            disabled={readOnly}
            onChange={(on) => patchConfig({ makesOrder: on })}
            testId="question-quantity-makes-order"
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
