'use client';
import type { SearchHit } from '@hfos/core';
import { GreyLine, linesOf, plainRow, SnippetLine, type RowContext, type RowView } from './parts';

/** A task: its title and "Task · Due tomorrow · Sam Rivera", or the words of its notes that matched. */
export function taskRow(hit: SearchHit, ctx: RowContext): RowView {
  const { line } = linesOf(hit, ctx);
  return plainRow(hit, ctx, {
    line:
      hit.why.field === 'task_notes' && hit.why.snippet?.text ? (
        <>
          <GreyLine text={line} ctx={ctx} />: <SnippetLine hit={hit} />
        </>
      ) : (
        <GreyLine text={line} ctx={ctx} />
      ),
  });
}
