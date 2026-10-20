'use client';
import type { SearchHit } from '@hfos/core';
import {
  AmountChip,
  LineChip,
  linesOf,
  plainRow,
  WhyChip,
  type RowContext,
  type RowView,
} from './parts';

/**
 * An estimate, an invoice or a payment: "Invoice #1042", "Marcus Smith · 6 days overdue", the amount, and a payment's
 * "Paid Sep 30".
 */
export function moneyRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, {
    chips: (
      <>
        <WhyChip hit={hit} />
        <LineChip text={linesOf(hit, ctx).chip} />
        <AmountChip hit={hit} />
      </>
    ),
  });
}
