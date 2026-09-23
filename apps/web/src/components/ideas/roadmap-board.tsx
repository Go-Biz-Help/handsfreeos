import { IDEA_STATUS_MEANING, IDEA_STATUS_WORDS, IDEAS_WORDS } from '@hfos/core';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import type { IdeaArea, Roadmap, RoadmapCardRow } from '@/lib/api/types';
import { areaNames, dayWords, StatusPill } from './idea-bits';
import { VoteButton } from './vote-button';

const COLUMNS: readonly {
  key: keyof Roadmap;
  status: 'planned' | 'in_progress' | 'done';
  title: string;
}[] = [
  { key: 'planned', status: 'planned', title: IDEA_STATUS_WORDS.planned },
  { key: 'inProgress', status: 'in_progress', title: IDEA_STATUS_WORDS.in_progress },
  { key: 'done', status: 'done', title: IDEAS_WORDS.doneLately },
];

/**
 * The roadmap: what the team is going to build, what it is building, and what shipped in the last ninety days.
 * Planned and in progress are ordered by votes, so the column reads the way the team reads it.
 */
export function RoadmapBoard({
  workspaceId,
  roadmap,
  areas,
}: {
  workspaceId: string;
  roadmap: Roadmap;
  areas: readonly IdeaArea[];
}) {
  const names = areaNames(areas);
  return (
    <div className="grid gap-4 md:grid-cols-3" data-testid="roadmap">
      {COLUMNS.map((col) => {
        const cards: readonly RoadmapCardRow[] = roadmap[col.key];
        return (
          <section key={col.key} aria-label={col.title} data-testid={`roadmap-${col.status}`}>
            <div className="mb-2 flex items-center gap-2">
              <StatusPill status={col.status} />
              <span className="text-[13px] text-text-3">{cards.length}</span>
            </div>
            <p className="mb-3 text-xs text-text-3">{IDEA_STATUS_MEANING[col.status]}</p>
            {cards.length === 0 ? (
              <p className="rounded-card border border-dashed border-border-strong px-4 py-6 text-center text-[13px] text-text-3">
                {IDEAS_WORDS.roadmapEmpty[col.status]}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {cards.map((c) => (
                  <li key={c.id}>
                    <Card className="flex gap-3 p-3">
                      <VoteButton
                        ideaId={c.id}
                        workspaceId={workspaceId}
                        voted={c.voted}
                        count={c.voteCount}
                        open={col.status !== 'done'}
                      />
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/app/w/${workspaceId}/ideas/${c.id}`}
                          className="line-clamp-3 text-sm font-semibold leading-snug hover:underline"
                        >
                          {c.title}
                        </Link>
                        <p className="mt-1 text-xs text-text-3">
                          {names.get(c.areaId) ?? IDEAS_WORDS.somethingElse}
                          {col.status === 'done' && c.statusChangedAt
                            ? ` · ${dayWords(c.statusChangedAt)}`
                            : ''}
                        </p>
                      </div>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
