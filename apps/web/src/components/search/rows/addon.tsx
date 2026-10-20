'use client';
import type { SearchHit } from '@hfos/core';
import { RecordIcon } from '@/components/relationships/record-icon';
import { GreyLine, HitTitle, WhyChip, type RowContext, type RowView } from './parts';

/**
 * An add-on's hit (Real Estate's Listings, Deals, Homes and Properties), from what the add-on said about it: its
 * title, its own line ("Active · $389,000 · 3 bd · 2 ba"), its badges and its own chip ("MLS number"). Nothing of the
 * add-on's own code is drawn here, so nothing in its folder is imported.
 */
export function addonRow(hit: SearchHit, ctx: RowContext): RowView {
  return {
    leading: <RecordIcon icon={ctx.icon} size="md" />,
    title: <HitTitle hit={hit} ctx={ctx} />,
    line: <GreyLine text={hit.subtitle} ctx={ctx} />,
    chips: <WhyChip hit={hit} />,
  };
}
