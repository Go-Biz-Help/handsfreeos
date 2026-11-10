'use client';
/**
 * Costs and profit, as the estimate builder, a sent estimate and the panel on core's estimate page all show them
 * (docs/contractor.md, "Costs and estimates"): one option's price before tax, what it costs to do, and what's left,
 * in red when it's under the business's lowest margin. Only people who may see job costs get the figures at all.
 */
import {
  marginWords,
  type OkReason,
  type OptionCosting,
} from '@hfos/core/addons/contractor/estimating';
import { CONTRACTOR_WORDS, hoursWords, okNeededWords } from '@hfos/core/addons/contractor/words';
import { money } from '@hfos/core';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { TotalRow } from '@/components/money/totals';
import { cn } from '@/lib/utils';

const C = CONTRACTOR_WORDS.builder.costing;

export interface CostedOption {
  readonly name: string | null;
  readonly costing: OptionCosting;
}

export interface CheckSummary {
  readonly needsOk: OkReason | null;
  readonly lowest: { readonly name: string | null; readonly marginBp: number | null } | null;
  readonly minMarginBp: number;
  readonly uncosted: number;
}

/** A margin, red when it's under the lowest one. */
export function Margin({
  bp,
  minBp,
  className,
  testId,
}: {
  bp: number | null;
  minBp: number;
  className?: string;
  testId?: string;
}) {
  if (bp === null) return <span className={cn('text-text-3', className)}>—</span>;
  return (
    <span
      className={cn(bp < minBp ? 'text-danger-text' : 'text-success-text', className)}
      data-testid={testId}
    >
      {marginWords(bp)}
    </span>
  );
}

/** One option's figures, top to bottom: price, each kind of cost, profit, margin. */
export function CostingRows({ costing, minBp }: { costing: OptionCosting; minBp: number }) {
  return (
    <>
      <TotalRow label={C.price} value={money(costing.priceCents)} testId="costing-price" />
      <TotalRow
        label={costing.laborHours > 0 ? `${C.labor} · ${hoursWords(costing.laborHours)}` : C.labor}
        value={money(costing.laborCents)}
      />
      <TotalRow label={C.materials} value={money(costing.materialsCents)} />
      {costing.otherCents > 0 ? (
        <TotalRow label={C.other} value={money(costing.otherCents)} />
      ) : null}
      <TotalRow label={C.cost} value={money(costing.costCents)} testId="costing-cost" />
      <TotalRow
        label={C.profit}
        value={
          <span className={costing.profitCents < 0 ? 'text-danger-text' : undefined}>
            {money(costing.profitCents)}
          </span>
        }
        big
        testId="costing-profit"
      />
      <TotalRow
        label={C.margin}
        value={
          <Margin bp={costing.marginBp} minBp={minBp} className="font-semibold" testId="margin" />
        }
        testId="costing-margin"
      />
    </>
  );
}

/** Every option's margin side by side, for an estimate that offers more than one. */
export function OptionMargins({
  options,
  minBp,
}: {
  options: readonly CostedOption[];
  minBp: number;
}) {
  if (options.length < 2) return null;
  return (
    <ul className="mt-2 space-y-1 border-t border-border pt-2 text-[13px]">
      {options.map((o, i) => (
        <li key={i} className="flex items-center justify-between gap-3">
          <span className="truncate text-text-2">{o.name || `Option ${i + 1}`}</span>
          <span className="flex-none tabular-nums">
            {money(o.costing.profitCents)} ·{' '}
            <Margin bp={o.costing.marginBp} minBp={minBp} className="font-medium" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Whether it can go out as it is: the reason it waits for an OK, or that it's fine. */
export function CheckNote({
  check,
  options,
  children,
}: {
  check: CheckSummary;
  options: number;
  /** What to do about it, under the reason. */
  children?: ReactNode;
}) {
  const why = okNeededWords(check);
  if (!why)
    return (
      <p
        className="mt-3 flex items-start gap-2 text-[12.5px] text-text-2"
        data-testid="costing-fine"
      >
        <CheckCircle2 className="mt-px h-3.5 w-3.5 flex-none text-success-text" strokeWidth={2} />
        <span>
          {options > 1 ? C.fine : C.fineOne} {C.lowest(marginWords(check.minMarginBp))}
        </span>
      </p>
    );
  return (
    <div
      className="mt-3 rounded-menu bg-danger-soft px-3 py-2.5 text-[12.5px] leading-[1.45] text-danger-text"
      role="status"
      data-testid="costing-warning"
    >
      <p className="flex items-start gap-2">
        <AlertTriangle className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={2} />
        <span>
          {why} {CONTRACTOR_WORDS.builder.ok.needed}
        </span>
      </p>
      {children}
    </div>
  );
}
