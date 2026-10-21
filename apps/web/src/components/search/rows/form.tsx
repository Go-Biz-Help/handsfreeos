'use client';
import type { SearchHit } from '@hfos/core';
import { GreyLine, linesOf, plainRow, SnippetLine, type RowContext, type RowView } from './parts';

/** A form, or one person's answers to it: "Answered by Jo Smithers · Oct 19 · “50 gallon, gas”" with Form answer. */
export function formRow(hit: SearchHit, ctx: RowContext): RowView {
  const { line } = linesOf(hit, ctx);
  const snippet = hit.why.snippet?.text ? <SnippetLine hit={hit} /> : null;
  return plainRow(hit, ctx, {
    line:
      line && snippet ? (
        <>
          <GreyLine text={line} ctx={ctx} /> · {snippet}
        </>
      ) : (
        (snippet ?? <GreyLine text={line} ctx={ctx} />)
      ),
  });
}
