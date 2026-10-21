'use client';
import type { SearchHit } from '@hfos/core';
import { Badge } from '@/components/ui/badge';
import { plainRow, type RowContext, type RowView } from './parts';

/** Something in the Deleted bin: its name, what it is, and "Deleted 4 days ago · Gone for good in 26 days". */
export function binRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, {
    chips: hit.subtitle ? (
      <Badge variant="gray" className="h-5 px-1.5 text-[11.5px]">
        {hit.subtitle}
      </Badge>
    ) : null,
  });
}
