'use client';
import type { SearchHit } from '@hfos/core';
import { LineWithSnippet, plainRow, type RowContext, type RowView } from './parts';

/** A file: its name, and "On Marcus Smith · page 3: “Owner: Marcus Smith, 2210 Clearview…”" with In the file. */
export function fileRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, { line: <LineWithSnippet hit={hit} ctx={ctx} /> });
}
