'use client';
import { relativeTimeAgo, type SearchHit } from '@hfos/core';
import {
  GreyLine,
  linesOf,
  plainRow,
  SnippetLine,
  WhyChip,
  type RowContext,
  type RowView,
} from './parts';

/**
 * A conversation: "Text from Dana Smith" with its best message as the snippet, or "Texts with Dana Smith" with "Last
 * one 2 days ago · 14 messages" when the thread itself matched; when it was, on the right.
 */
export function messageRow(hit: SearchHit, ctx: RowContext): RowView {
  return plainRow(hit, ctx, {
    line: hit.why.snippet?.text ? (
      <SnippetLine hit={hit} />
    ) : (
      <GreyLine text={linesOf(hit, ctx).line} ctx={ctx} />
    ),
    chips: (
      <>
        <WhyChip hit={hit} />
        {hit.at ? (
          <span className="whitespace-nowrap text-xs text-text-3">
            {relativeTimeAgo(hit.at, ctx.now)}
          </span>
        ) : null}
      </>
    ),
  });
}
