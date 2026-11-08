'use client';
/**
 * The standouts a Playbook item or an idea came from (docs/socialcontent.md, part 3): each a small link that opens
 * the post on its network, named by its creator and kind.
 */
import { SOCIALCONTENT_WORDS as W } from '@hfos/core/addons/socialcontent/words';
import { ExternalLink } from 'lucide-react';
import type { StandoutRef } from './types';

export function StandoutLinks({
  label,
  ids,
  examples,
}: {
  label: string;
  ids: readonly string[];
  examples: ReadonlyMap<string, StandoutRef>;
}) {
  const shown = ids.flatMap((id) => {
    const e = examples.get(id);
    return e ? [e] : [];
  });
  if (!shown.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-text-3">
      <span>{label}</span>
      {shown.map((e) => (
        <a
          key={e.id}
          href={e.link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-accent-text hover:underline"
        >
          {e.creatorShown} · {W.kinds[e.kind]}
          <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden />
        </a>
      ))}
    </div>
  );
}
