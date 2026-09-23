'use client';
import { IDEA_SORT_WORDS, relativeTimeAgo, type IdeaStatus } from '@hfos/core';
import { ChevronUp, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { StatusPill } from '@/components/ideas/idea-bits';
import { ButtonLink } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import type { IdeaArea, IdeaTriage } from '@/lib/api/types';
import { cn } from '@/lib/utils';
import { TRIAGE_TABS, type TriageTab } from './ideas-triage-tabs';

/**
 * The team's view of the board: who shared each idea, from which business, and how many different businesses
 * voted for it — "twelve businesses" means more than "forty votes from one". Filters live in the address.
 */
export function IdeasTriage({
  data,
  tab,
  sort,
  search,
  areaId,
  areas,
  canManage,
}: {
  data: IdeaTriage;
  tab: TriageTab;
  sort: 'trending' | 'top' | 'new';
  search: string;
  areaId: string | null;
  areas: readonly IdeaArea[];
  canManage: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(search);
  const names = new Map(areas.map((a) => [a.id, a.name]));

  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === '') q.delete(k);
      else q.set(k, v);
    }
    q.delete('cursor');
    router.push(`/admin/ideas${q.size ? `?${q}` : ''}`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go({ q: term.trim() || null });
  };
  const countFor = (key: TriageTab): number | null =>
    key === 'hidden'
      ? data.counts.hidden
      : key === 'all' || key === 'merged'
        ? null
        : data.counts[key as IdeaStatus];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">Ideas</h1>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <ButtonLink href="/admin/ideas/areas" variant="ghost" size="sm">
              Areas
            </ButtonLink>
          ) : null}
          <ButtonLink href="/admin/ideas/whats-new" size="sm" data-testid="admin-whats-new">
            What’s new
          </ButtonLink>
        </div>
      </div>
      <p className="mt-1 text-[13px] text-text-3">
        {data.counts.under_review} waiting for an answer · {data.counts.planned} planned ·{' '}
        {data.counts.in_progress} being built
      </p>

      <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-center">
        <form onSubmit={submit} className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search ideas"
            aria-label="Search ideas"
            className="pl-10"
            data-testid="triage-search"
          />
        </form>
        <Select
          selectSize="sm"
          aria-label="Area"
          value={areaId ?? ''}
          onChange={(e) => go({ area: e.target.value || null })}
          className="w-auto"
        >
          <option value="">Every area</option>
          {areas.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Segmented
          value={sort}
          onChange={(v) => go({ sort: v === 'top' ? null : v })}
          ariaLabel="Sort"
          options={(['top', 'trending', 'new'] as const).map((v) => ({
            value: v,
            label: IDEA_SORT_WORDS[v],
          }))}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {TRIAGE_TABS.map((t) => {
          const on = t.key === tab;
          const n = countFor(t.key);
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => go({ show: t.key === 'under_review' ? null : t.key })}
              data-testid={`triage-tab-${t.key}`}
              className={cn(
                'h-8 rounded-control px-3 text-[13px] font-medium',
                on ? 'bg-accent-soft text-accent-text' : 'text-text-2 hover:bg-card-2',
              )}
            >
              {t.label}
              {n ? <span className="ml-1.5 text-text-3">{n}</span> : null}
            </button>
          );
        })}
      </div>

      {data.ideas.length === 0 ? (
        <div className="mt-6 rounded-card border border-border bg-card px-5 py-12 text-center">
          <p className="text-sm font-medium">Nothing here.</p>
          <p className="mt-1 text-[13px] text-text-3">
            {tab === 'under_review'
              ? 'Every idea has an answer. That is the whole idea.'
              : 'No ideas match this.'}
          </p>
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
          {data.ideas.map((i) => (
            <li key={i.id}>
              <Link
                href={`/admin/ideas/${i.id}`}
                className="flex gap-3 px-4 py-3.5 hover:bg-card-2"
                data-testid={`triage-row-${i.number}`}
              >
                <span className="flex w-12 flex-none flex-col items-center rounded-control border border-border py-1.5 text-sm font-semibold tabular-nums">
                  <ChevronUp className="h-4 w-4 text-text-3" strokeWidth={1.75} aria-hidden />
                  {i.voteCount}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="text-xs tabular-nums text-text-3">#{i.number}</span>
                    <span className="min-w-0 truncate text-sm font-semibold">{i.title}</span>
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-text-3">
                    <StatusPill status={i.status} />
                    <span>{names.get(i.areaId) ?? i.areaId}</span>
                    <span aria-hidden>·</span>
                    <span>
                      {i.businessCount === 1 ? '1 business' : `${i.businessCount} businesses`}
                    </span>
                    {i.commentCount ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {i.commentCount === 1 ? '1 comment' : `${i.commentCount} comments`}
                        </span>
                      </>
                    ) : null}
                    {i.hidden ? (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-text">
                        Taken down
                      </span>
                    ) : null}
                    {i.mergedInto ? <span>Merged into #{i.mergedInto.number}</span> : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-text-2">
                    {i.author ? i.author.name || i.author.email : 'Someone who left'}
                    {i.business ? ` · ${i.business.name}` : ''} ·{' '}
                    <span suppressHydrationWarning>{relativeTimeAgo(i.createdAt)}</span>
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {data.nextCursor ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => {
              const q = new URLSearchParams(params.toString());
              q.set('cursor', data.nextCursor!);
              router.push(`/admin/ideas?${q}`);
            }}
            className="h-9 rounded-control px-4 text-sm font-medium text-accent-text hover:bg-accent-soft"
          >
            Next page
          </button>
        </div>
      ) : null}
    </div>
  );
}
