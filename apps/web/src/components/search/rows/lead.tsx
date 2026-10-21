'use client';
import type { SearchHit } from '@hfos/core';
import { AmountChip, plainRow, WhyChip, type RowContext, type RowView } from './parts';

/** A lead: its title, "Dana Smith · Installs › Quote sent", and what it's worth. */
export function leadRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, {
    chips: (
      <>
        <WhyChip hit={hit} />
        <AmountChip hit={hit} />
      </>
    ),
  });
}
