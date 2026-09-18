import {
  LINE_COLUMNS,
  lineDiscountLabel,
  lineRateLabel,
  money,
  NO_TAX_ON_LINE,
  totalsRows,
  type TotalsMoney,
  type TotalsShape,
} from '@hfos/core';
import * as React from 'react';
import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { LineRow } from '@/money/use-money';

/**
 * A document as it reads once it has gone out: the lines frozen and the totals adding up, exactly as the web's
 * `DocumentView` draws them, from core's own rows (`totalsRows`) so the two can never drift apart.
 *
 * At 390 px a line's quantity and price go under its name rather than in columns of their own, which is what the web
 * does below its `sm` breakpoint too.
 */
export function DocumentLines({
  lines,
  totals,
  moneyOn,
  taxed,
}: {
  lines: readonly LineRow[];
  totals: TotalsShape;
  moneyOn?: TotalsMoney;
  taxed: boolean;
}) {
  return (
    <Card className="px-3.5 py-3" testID="document-lines">
      <View className="flex-row justify-between pb-1.5">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {LINE_COLUMNS[0]}
        </Text>
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
          {LINE_COLUMNS[3]}
        </Text>
      </View>
      {lines.map((line) => (
        <View
          key={line.id}
          className="flex-row items-start gap-3 border-t border-border py-2.5"
          testID="document-line"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-[13.5px] font-medium leading-[18px]">{line.name}</Text>
            {line.description ? (
              <Text className="mt-px text-xs leading-[17px] text-text-3">{line.description}</Text>
            ) : null}
            <Text className="mt-px text-xs text-text-3">
              {lineRateLabel({
                quantity: line.quantity,
                unitLabel: line.unit_label,
                unitPriceCents: line.unit_price_cents,
              })}
            </Text>
            {line.discount_cents > 0 ? (
              <Text className="mt-px text-xs text-success-text">
                {lineDiscountLabel(line.discount_cents)}
              </Text>
            ) : null}
            {taxed && !line.taxable ? (
              <Text className="mt-px text-xs text-text-3">{NO_TAX_ON_LINE}</Text>
            ) : null}
          </View>
          <Text className="text-[13.5px] font-semibold">{money(line.amount_cents)}</Text>
        </View>
      ))}
      <View className="mt-1 border-t border-border pt-2">
        <Totals totals={totals} moneyOn={moneyOn} />
      </View>
    </Card>
  );
}

/** The totals block: core's rows, in core's order. */
export function Totals({ totals, moneyOn }: { totals: TotalsShape; moneyOn?: TotalsMoney }) {
  return (
    <View testID="money-totals">
      {totalsRows(totals, moneyOn ?? {}).map((row) => (
        <View
          key={row.key}
          testID={`totals-${row.key}`}
          className={cn(
            'flex-row items-center justify-between gap-4 py-1.5',
            row.big && 'mt-1 border-t border-border pt-2.5',
          )}
        >
          <Text
            className={cn(
              'text-[13.5px] text-text-2',
              row.big && 'text-base font-semibold text-text',
            )}
          >
            {row.label}
          </Text>
          <Text
            className={cn(
              'text-[13.5px] font-medium',
              row.big && 'text-base font-semibold',
              row.credit && 'text-success-text',
            )}
          >
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The totals a synced row carries, as core's shape. */
export function totalsOf(row: {
  subtotal_cents: number | null;
  discount_cents: number | null;
  discount_percent_bp: number | null;
  taxable_base_cents: number | null;
  tax_cents: number | null;
  tax_rate_bp: number | null;
  tax_label: string | null;
  total_cents: number | null;
}): TotalsShape {
  return {
    subtotalCents: row.subtotal_cents ?? 0,
    discountCents: row.discount_cents ?? 0,
    discountPercentBp: row.discount_percent_bp,
    taxableBaseCents: row.taxable_base_cents ?? 0,
    taxCents: row.tax_cents ?? 0,
    taxRateBp: row.tax_rate_bp ?? 0,
    taxLabel: row.tax_label,
    totalCents: row.total_cents ?? 0,
  };
}
