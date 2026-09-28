'use client';
/**
 * The Add-ons page, "Vote on what's next" (0109): every planned add-on still up for a vote, searchable, filtered by
 * category and group, sorted by votes or name, with an upvote on each. A business has one vote per add-on and
 * votes for as many as it likes (the owner's decisions, 2026-09-28); every Sunday at midnight Eastern the one with
 * the most votes becomes Coming soon.
 *
 * The search, the filters and the order are core's (`filterPlanned` and the rest of addons/roadmap.ts), so the
 * phone's screen finds and orders exactly the same. A vote shows at once and puts itself right if the server says
 * otherwise, as the ideas board's does; after a refusal the page is read again, since it may have been picked.
 */
import {
  ADDON_CATEGORY_WORDS,
  ADDON_PAGE_WORDS as W,
  filterPlanned,
  plannedCategories,
  plannedCategoryCounts,
  plannedGroups,
  withVote,
  type AddonCategory,
  type PlannedAddonView,
  type PlannedSort,
} from '@hfos/core';
import { ChevronUp, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Select } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

const categoryWord = (c: string) => ADDON_CATEGORY_WORDS[c as AddonCategory] ?? c;

export function PlannedList({
  workspaceId,
  planned,
}: {
  workspaceId: string;
  planned: readonly PlannedAddonView[];
}) {
  const router = useRouter();
  const [list, setList] = useState<readonly PlannedAddonView[]>(planned);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [sort, setSort] = useState<PlannedSort>('votes');
  // A refresh from the server is the truth.
  useEffect(() => setList(planned), [planned]);

  const counts = useMemo(() => plannedCategoryCounts(list, query), [list, query]);
  const categories = useMemo(() => plannedCategories(list), [list]);
  const groups = useMemo(() => plannedGroups(list, category), [list, category]);
  // In the order the page was drawn in, with the votes as they are now: a card never jumps away from the press.
  const shown = useMemo(() => {
    const now = new Map(list.map((a) => [a.addonId, a]));
    return filterPlanned(planned, { query, category, group }, sort).map(
      (a) => now.get(a.addonId) ?? a,
    );
  }, [planned, list, query, category, group, sort]);
  // A group from another category isn't one this category has.
  useEffect(() => {
    if (group && !groups.includes(group)) setGroup(null);
  }, [group, groups]);

  const pickCategory = (c: string | null) => {
    setCategory(c);
    setGroup(null);
  };
  const clear = () => {
    setQuery('');
    pickCategory(null);
  };

  const press = async (a: PlannedAddonView) => {
    if (busy.has(a.addonId)) return;
    const next = !a.voted;
    const put = (fn: (x: PlannedAddonView) => PlannedAddonView) =>
      setList((all) => all.map((x) => (x.addonId === a.addonId ? fn(x) : x)));
    setBusy((b) => new Set(b).add(a.addonId));
    put((x) => withVote(x, next));
    try {
      const out = unwrap(
        await apiBrowser().POST(next ? '/v1/commands/addon.vote' : '/v1/commands/addon.unvote', {
          body: { workspaceId, addonId: a.addonId },
        }),
      );
      put((x) => ({ ...x, voted: out.voted, votes: out.votes }));
      toast.success(out.voted ? W.votedDone(a.name) : W.unvotedDone(a.name));
    } catch (e) {
      put((x) => withVote(x, !next));
      toast.error(errorMessage(e));
      router.refresh();
    } finally {
      setBusy((b) => {
        const left = new Set(b);
        left.delete(a.addonId);
        return left;
      });
    }
  };

  const chip = (value: string | null, label: string, count: number) => {
    const on = category === value;
    return (
      <button
        key={value ?? 'all'}
        type="button"
        aria-pressed={on}
        onClick={() => pickCategory(value)}
        data-testid={`planned-category-${value ?? 'all'}`}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
          on
            ? 'border-accent bg-accent text-white'
            : 'border-border-strong bg-card text-text hover:bg-card-2',
        )}
      >
        {label}
        <span
          className={cn(
            'font-mono text-[11.5px] tabular-nums',
            on ? 'text-white/85' : 'text-text-3',
          )}
        >
          {count}
        </span>
      </button>
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="planned-list">
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-3"
            strokeWidth={1.5}
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={W.searchPlanned}
            aria-label={W.searchPlannedLabel}
            data-testid="planned-search"
            className="pl-10"
          />
        </div>
        <div className="flex gap-2">
          <Select
            aria-label={W.groupLabel}
            value={group ?? ''}
            onChange={(e) => setGroup(e.target.value || null)}
            className="w-auto min-w-0 max-w-[16rem]"
            data-testid="planned-group"
          >
            <option value="">{W.allGroups}</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
          <Select
            aria-label={W.sortLabel}
            value={sort}
            onChange={(e) => setSort(e.target.value as PlannedSort)}
            className="w-auto"
            data-testid="planned-sort"
          >
            <option value="votes">{W.sortVotes}</option>
            <option value="az">{W.sortAz}</option>
          </Select>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
        {chip(null, W.allCategories, counts['all'] ?? 0)}
        {categories.map((c) => chip(c, categoryWord(c), counts[c] ?? 0))}
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-[12.5px] text-text-3">
        <span data-testid="planned-count">{W.plannedCount(shown.length)}</span>
        <span>{W.tapTag}</span>
      </div>
      {shown.length ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {shown.map((a) => (
            <li
              key={a.addonId}
              className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-card p-4"
              data-testid={`planned-${a.addonId}`}
            >
              <div className="flex items-start gap-3">
                <h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{a.name}</h3>
                <button
                  type="button"
                  onClick={() => void press(a)}
                  aria-pressed={a.voted}
                  aria-label={
                    a.voted ? W.takeBackLabel(a.name, a.votes) : W.upvoteLabel(a.name, a.votes)
                  }
                  title={a.voted ? W.comingSoonVoted : W.upvote}
                  data-testid={`planned-vote-${a.addonId}`}
                  className={cn(
                    'flex h-[52px] w-[52px] flex-none flex-col items-center justify-center rounded-control border text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                    a.voted
                      ? 'border-accent bg-accent-soft text-accent-text'
                      : 'border-border bg-card text-text hover:border-border-strong hover:bg-card-2',
                  )}
                >
                  <ChevronUp className="h-4 w-4" strokeWidth={a.voted ? 2.25 : 1.75} aria-hidden />
                  <span data-testid={`planned-votes-${a.addonId}`}>{a.votes}</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => pickCategory(a.category)}
                  className="rounded-md bg-accent-soft px-2 py-px text-xs text-accent-text hover:underline"
                >
                  {categoryWord(a.category)}
                </button>
                {a.groups.map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => {
                      setCategory(a.category);
                      setGroup(g);
                    }}
                    className="rounded-md bg-card-2 px-2 py-px text-xs text-text-2 hover:underline"
                  >
                    {g}
                  </button>
                ))}
              </div>
              <p className="text-[13.5px] leading-relaxed text-text-2">{a.summary}</p>
              {a.overlap ? (
                <p className="self-start rounded-md bg-warning-soft px-2 py-1 text-[12.5px] text-warning-text">
                  <span className="font-medium">{W.alreadyIn}:</span> {a.overlap}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div data-testid="planned-none">
          <EmptyState
            title={W.noneMatchTitle}
            dashed
            actions={
              <Button variant="secondary" size="sm" onClick={clear}>
                {W.clearFilters}
              </Button>
            }
          >
            {W.noneMatch}
          </EmptyState>
        </div>
      )}
    </div>
  );
}
