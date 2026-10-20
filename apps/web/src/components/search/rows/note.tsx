'use client';
import { marksIn, type SearchHit } from '@hfos/core';
import { GreyLine, linesOf, plainRow, SnippetLine, type RowContext, type RowView } from './parts';

/**
 * A note, a logged call or a visit: its first line as the title, and "Note on Dana Smith · Oct 18". When the words
 * matched further into it than its title shows, the stretch around them follows.
 */
export function noteRow(hit: SearchHit, ctx: RowContext): RowView {
  const { line } = linesOf(hit, ctx);
  const inTitle = marksIn(hit.title, ctx.probes).length > 0;
  return plainRow(hit, ctx, {
    line:
      hit.why.field === 'note' && !inTitle && hit.why.snippet?.text ? (
        <>
          <GreyLine text={line} ctx={ctx} />: <SnippetLine hit={hit} />
        </>
      ) : (
        <GreyLine text={line} ctx={ctx} />
      ),
  });
}
