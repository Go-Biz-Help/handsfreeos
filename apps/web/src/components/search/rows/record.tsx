'use client';
import type { SearchHit } from '@hfos/core';
import { RecordIcon } from '@/components/relationships/record-icon';
import { plainRow, type RowContext, type RowView } from './parts';

/** A record of one of the business's own kinds: its kind's picture, its name, and its own fields in a line. */
export function recordRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, { leading: <RecordIcon icon={ctx.icon} size="md" /> });
}
