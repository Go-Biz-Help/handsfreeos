'use client';
import { IDEA_SORT_WORDS, IDEA_STATUS_WORDS, IDEA_STATUSES, relativeTimeAgo } from '@hfos/core';
import { MessageSquare, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { IdeaArea, IdeaRow } from '@/lib/api/types';
import { areaNames, StatusPill } from './idea-bits';
import { ShareIdea } from './share-idea';
import { VoteButton } from './vote-button';

export type BoardSort = 'trending' | 'top' | 'new';
export type BoardStatus = 'open' | 'all' | (typeof IDEA_STATUSES)[number];
export type BoardMine = 'shared' | 'voted' | 'following';

export interface BoardFilters {
  readonly sort: BoardSort;
  readonly status: BoardStatus;
  readonly areaId: string | null;
  readonly search: string;
  readonly mine: BoardMine | null;
}

const MINE_WORDS: Record<BoardMine, string> = {
  shared: 'Shared by me',
  voted: 'My votes',
  following: 'Following',
};

/**
 * The board: every idea still being voted on, the ones moving lately first. Filters live in the address, so a
 * link to "planned money ideas" is a link somebody can send; "Show more" adds the next page below.
 */
export function IdeasBoard({
  workspaceId,
  ideas,
  nextCursor,
  areas,
  filters,
}: {
  workspaceId: string;
  ideas: readonly IdeaRow[];
  nextCursor: string | null;
  areas: readonly IdeaArea[];
  filters: BoardFilters;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(filters.search);
  const [more, setMore] = useState<IdeaRow[]>([]);
  const [cursor, setCursor] = useState(nextCursor);
  const [loading, setLoading] = useState(false);
  const names = areaNames(areas);
  const base = `/app/w/${workspaceId}/ideas`;

  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') q.delete(k);
      else q.set(k, v);
    }
    router.push(`${base}${q.size ? `?${q}` : ''}`);
  };
  const search = (e: FormEvent) => {
    e.preventDefault();
    go({ q: term.trim() || null });
  };

  const showMore = async () => {
    if (!cursor) return;
    setLoading(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/idea.list', {
          body: {
            sort: filters.sort,
            status: filters.status,
            ...(filters.areaId ? { areaId: filters.areaId } : {}),
            ...(filters.search ? { search: filters.search } : {}),
            ...(filters.mine ? { mine: filters.mine } : {}),
            cursor,
          },
        }),
      );
      setMore((m) => [...m, ...out.ideas]);
      setCursor(out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const all = [...ideas, ...more.filter((m) => !ideas.some((i) => i.id === m.id))];
  const filtered = filters.status !== 'open' || filters.areaId || filters.search || filters.mine;

  return (
    <div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <form onSubmit={search} className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search ideas"
            aria-label="Search ideas"
            data-testid="ideas-search"
            className="pl-10"
          />
        </form>
        <Segmented
          value={filters.sort}
          onChange={(v) => go({ sort: v === 'trending' ? null : v })}
          ariaLabel="Sort ideas"
          options={(['trending', 'top', 'new'] as const).map((v) => ({
            value: v,
            label: IDEA_SORT_WORDS[v],
            testId: `ideas-sort-${v}`,
          }))}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Select
          selectSize="sm"
          aria-label="Status"
          value={filters.status}
          onChange={(e) => go({ status: e.target.value === 'open' ? null : e.target.value })}
          className="w-auto"
          data-testid="ideas-status"
        >
          <option value="open">Open ideas</option>
          {IDEA_STATUSES.map((s) => (
            <option key={s} value={s}>
              {IDEA_STATUS_WORDS[s]}
            </option>
          ))}
          <option value="all">Every idea</option>
        </Select>
        <Select
          selectSize="sm"
          aria-label="Area"
          value={filters.areaId ?? ''}
          onChange={(e) => go({ area: e.target.value || null })}
          className="w-auto"
          data-testid="ideas-area"
        >
          <option value="">Every part of HandsFreeOS</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.openCount ? ` (${a.openCount})` : ''}
            </option>
          ))}
        </Select>
        <Select
          selectSize="sm"
          aria-label="Whose"
          value={filters.mine ?? ''}
          onChange={(e) => go({ mine: e.target.value || null })}
          className="w-auto"
          data-testid="ideas-mine"
        >
          <option value="">Everybody’s</option>
          {(Object.keys(MINE_WORDS) as BoardMine[]).map((m) => (
            <option key={m} value={m}>
              {MINE_WORDS[m]}
            </option>
          ))}
        </Select>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={() => router.push(base)}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {all.length === 0 ? (
        <Card className="mt-4">
          <EmptyState
            title={filtered ? 'No ideas match that' : 'No ideas yet'}
            actions={
              filtered ? null : (
                <ShareIdea workspaceId={workspaceId} areas={areas} label="Share the first one" />
              )
            }
          >
            {filtered
              ? 'Try another word, or clear the filters.'
              : 'What would make HandsFreeOS better for your business? Be the first to say.'}
          </EmptyState>
        </Card>
      ) : (
        <Card className="mt-4 overflow-hidden">
          <ul className="divide-y divide-border" data-testid="ideas-list">
            {all.map((idea) => (
              <li key={idea.id} className="flex gap-3 px-4 py-3.5 md:gap-4" data-testid="idea-row">
                <VoteButton
                  ideaId={idea.id}
                  workspaceId={workspaceId}
                  voted={idea.voted}
                  count={idea.voteCount}
                  open={
                    idea.status === 'under_review' ||
                    idea.status === 'planned' ||
                    idea.status === 'in_progress'
                  }
                />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`${base}/${idea.id}`}
                    className="text-[15px] font-semibold leading-snug hover:underline"
                  >
                    {idea.title}
                  </Link>
                  {idea.excerpt ? (
                    <p className="mt-0.5 line-clamp-2 text-[13px] text-text-2">{idea.excerpt}</p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
                    <StatusPill status={idea.status} />
                    <span>{names.get(idea.areaId) ?? 'Something else'}</span>
                    {idea.commentCount ? (
                      <span className="inline-flex items-center gap-1">
                        <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        {idea.commentCount}
                        <span className="sr-only">comments</span>
                      </span>
                    ) : null}
                    <span suppressHydrationWarning>
                      {idea.author.you ? 'You' : idea.author.name || 'Someone'} ·{' '}
                      {relativeTimeAgo(idea.createdAt)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {cursor ? (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" onClick={showMore} loading={loading} data-testid="ideas-more">
            Show more ideas
          </Button>
        </div>
      ) : null}
    </div>
  );
}
