'use client';
/**
 * Item costs (docs/contractor.md, "Costs and estimates"): what each item on the business's price list costs it, and
 * how it's costed (labor by the hour, a material, or something else), so a line picked in the estimate builder
 * arrives with its cost. The price list itself is core's, in Settings → Products.
 */
import { COST_KINDS, marginBpOf, type CostKind } from '@hfos/core/addons/contractor/estimating';
import {
  CONTRACTOR_WORDS,
  COST_KIND_HINTS,
  COST_KIND_WORDS,
} from '@hfos/core/addons/contractor/words';
import { money, parseMoney } from '@hfos/core';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { Margin } from './costing';
import type { ItemCost } from './types';
import { useAct } from './use-act';

const W = CONTRACTOR_WORDS.costs;

export function ItemCostsPage({
  workspaceId,
  items,
  minMarginBp,
  canEditProducts,
}: {
  workspaceId: string;
  items: readonly ItemCost[];
  minMarginBp: number;
  canEditProducts: boolean;
}) {
  const [q, setQ] = useState('');
  const words = q.trim().toLowerCase();
  const shown = words
    ? items.filter((i) => `${i.name} ${i.description ?? ''}`.toLowerCase().includes(words))
    : items;
  return (
    <div className="max-w-[920px]" data-testid="contractor-costs">
      <PageHeader
        title={W.title}
        description={W.lede}
        actions={
          canEditProducts ? (
            <ButtonLink href={`/app/w/${workspaceId}/settings/payments/products`}>
              {W.products}
            </ButtonLink>
          ) : null
        }
      />
      {items.length ? (
        <div className="relative mb-4 max-w-[320px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" />
          <Input
            value={q}
            inputSize="sm"
            className="pl-8"
            placeholder={W.search}
            aria-label={W.search}
            onChange={(e) => setQ(e.target.value)}
            data-testid="costs-search"
          />
        </div>
      ) : null}
      <Card className="p-0">
        {shown.length === 0 ? (
          <p className="px-5 py-4 text-[13.5px] text-text-2">
            {items.length ? W.noneMatch : W.none}
          </p>
        ) : (
          <ul>
            {shown.map((item) => (
              <ItemRow
                key={item.productId}
                workspaceId={workspaceId}
                item={item}
                minMarginBp={minMarginBp}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ItemRow({
  workspaceId,
  item,
  minMarginBp,
}: {
  workspaceId: string;
  item: ItemCost;
  minMarginBp: number;
}) {
  const { busy, act } = useAct();
  const start = item.costCents === null ? '' : money(item.costCents);
  const [text, setText] = useState(start);
  const [kind, setKind] = useState<CostKind>(item.kind);
  const blank = text.trim() === '';
  const cents = blank ? null : parseMoney(text);
  const invalid = !blank && cents === null;
  const changed = !invalid && (cents !== item.costCents || (cents !== null && kind !== item.kind));
  const save = () =>
    void act(
      'save',
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/contractor.item_cost.set', {
            body: { workspaceId, productId: item.productId, costCents: cents, kind },
          }),
        ),
      cents === null ? W.cleared(item.name) : W.saved(item.name),
    );
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3 last:border-b-0"
      data-testid={`cost-row-${item.name}`}
    >
      <span className="min-w-[180px] flex-1">
        <span className="block truncate text-[13.5px] font-medium">{item.name}</span>
        <span className="block truncate text-[12.5px] text-text-3">
          {W.price} {money(item.unitPriceCents)} / {item.unitLabel}
        </span>
      </span>
      <Select
        selectSize="sm"
        className="w-[112px]"
        aria-label={`${W.kind}: ${item.name}`}
        value={kind}
        title={COST_KIND_HINTS[kind]}
        onChange={(e) => setKind(e.target.value as CostKind)}
        data-testid="cost-kind"
      >
        {COST_KINDS.map((k) => (
          <option key={k} value={k}>
            {COST_KIND_WORDS[k]}
          </option>
        ))}
      </Select>
      <Input
        inputSize="sm"
        inputMode="decimal"
        autoComplete="off"
        className="w-[112px] text-right tabular-nums"
        aria-label={`${W.cost}: ${item.name}`}
        placeholder={W.notSet}
        value={text}
        invalid={invalid}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && changed) save();
        }}
        data-testid="cost-input"
      />
      <span className="w-[64px] text-right text-[13px] tabular-nums">
        <Margin
          bp={cents === null || invalid ? null : marginBpOf(item.unitPriceCents, cents)}
          minBp={minMarginBp}
        />
      </span>
      <Button
        size="sm"
        variant="secondary"
        loading={busy === 'save'}
        disabled={!changed}
        onClick={save}
        data-testid="cost-save"
      >
        {W.save}
      </Button>
    </li>
  );
}
