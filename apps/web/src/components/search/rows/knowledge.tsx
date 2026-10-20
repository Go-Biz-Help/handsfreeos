'use client';
import type { SearchHit } from '@hfos/core';
import { GreyLine, linesOf, plainRow, SnippetLine, type RowContext, type RowView } from './parts';

/** A knowledge item: its title, and the stretch of it that matched. */
export function knowledgeRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, {
    line: hit.why.snippet?.text ? (
      <SnippetLine hit={hit} />
    ) : (
      <GreyLine text={linesOf(hit, ctx).line} ctx={ctx} />
    ),
  });
}
