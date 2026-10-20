'use client';
import type { SearchHit } from '@hfos/core';
import { PersonMark, plainRow, tileOf, type RowContext, type RowView } from './parts';

/**
 * Something archived, found by its name under Archived: greyed, with its Archived badge and "Archived Mar 3 · Restore
 * from the record’s menu". A contact keeps their avatar; everything else its kind's tile.
 */
export function archivedRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, {
    leading: hit.kind === 'contacts' ? <PersonMark hit={hit} /> : tileOf(hit.kind, ctx.icon),
  });
}
