import { lineDiscountLabel, lineRateLabel, money, NO_TAX_ON_LINE, unitWord } from '@hfos/core';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import type { MoneyLineRow } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { Totals, type TotalsShape } from './totals';

/** Core's, so the phone's document screen reads a line the same way. */
export { lineRateLabel, unitWord };

/**
 * A document as it reads once it has gone out: the lines frozen, the totals adding up, and the note the customer
 * was shown. Presentational on purpose — the Money section, the customer's own page and a print all render the
 * same thing from the same numbers.
 */
export function DocumentView({
  lines,
  totals,
  notes,
  paidCents,
  balanceCents,
  refundedCents,
  paidLabel,
  heading,
  aside,
  footer,
  className,
  testId = 'document-view',
}: {
  lines: readonly MoneyLineRow[];
  totals: TotalsShape;
  notes?: string | null;
  paidCents?: number;
  balanceCents?: number;
  refundedCents?: number;
  paidLabel?: string;
  /** What sits above the lines: the number, who it is for, when it went out. */
  heading?: ReactNode;
  /** Shown under the totals, inside the same block: a deposit, or what happens next. */
  aside?: ReactNode;
  footer?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const taxed = totals.taxRateBp > 0;
  return (
    <Card className={cn('overflow-hidden', className)} data-testid={testId}>
      {heading ? <div className="border-b border-border px-5 py-4">{heading}</div> : null}
      <div className="px-5 pb-1 pt-3.5">
        <div className="hidden grid-cols-[minmax(0,1fr)_104px_116px_112px] gap-3 pb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3 sm:grid">
          <span>Item</span>
          <span className="text-right">Qty</span>
          <span className="text-right">Price</span>
          <span className="text-right">Amount</span>
        </div>
        <ul>
          {lines.map((line) => (
            <li
              key={line.id}
              data-testid="document-line"
              className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-t border-border py-2.5 text-[13.5px] sm:grid-cols-[minmax(0,1fr)_104px_116px_112px]"
            >
              <span className="min-w-0">
                <span className="block font-medium leading-[1.35]">{line.name}</span>
                {line.description ? (
                  <span className="mt-px block text-xs leading-[1.4] text-text-3">
                    {line.description}
                  </span>
                ) : null}
                <span className="mt-px block text-xs text-text-3 sm:hidden">
                  {lineRateLabel(line)}
                </span>
                {line.discountCents > 0 ? (
                  <span className="mt-px block text-xs text-success-text">
                    {lineDiscountLabel(line.discountCents)}
                  </span>
                ) : null}
                {taxed && !line.taxable ? (
                  <span className="mt-px block text-xs text-text-3">{NO_TAX_ON_LINE}</span>
                ) : null}
              </span>
              <span className="hidden text-right tabular-nums text-text-2 sm:block">
                {line.quantity} {unitWord(line.quantity, line.unitLabel)}
              </span>
              <span className="hidden text-right tabular-nums text-text-2 sm:block">
                {money(line.unitPriceCents)}
              </span>
              <span className="whitespace-nowrap text-right font-semibold tabular-nums">
                {money(line.amountCents)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="border-t border-border px-5 py-3.5">
        <div className="ml-auto w-full sm:max-w-[340px]">
          <Totals
            totals={totals}
            paidCents={paidCents}
            balanceCents={balanceCents}
            refundedCents={refundedCents}
            paidLabel={paidLabel}
          />
          {aside}
        </div>
      </div>
      {notes?.trim() ? (
        <div className="border-t border-border px-5 py-3.5" data-testid="document-notes">
          <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Notes
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-[1.6] text-text-2">
            {notes}
          </p>
        </div>
      ) : null}
      {footer}
    </Card>
  );
}
