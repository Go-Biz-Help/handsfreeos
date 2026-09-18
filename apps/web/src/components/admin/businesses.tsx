'use client';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { sinceWords } from './ticket-bits';

export interface BusinessRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly organizationName: string;
  readonly memberCount: number;
  readonly lastActiveAt: string | null;
  readonly openTicketCount: number;
  readonly createdAt: string;
}

const SORTS = [
  { key: 'newest', label: 'Newest' },
  { key: 'busiest', label: 'Most active' },
  { key: 'quietest', label: 'Gone quiet' },
  { key: 'name', label: 'By name' },
] as const;

/** Every business on HandsFreeOS. The three numbers at the top are the ones Chris will look at daily. */
export function Businesses({
  businesses,
  totals,
  sort,
  search,
  nextCursor,
}: {
  businesses: readonly BusinessRow[];
  totals: { businesses: number; newThisWeek: number; activeThisWeek: number };
  sort: string;
  search: string;
  nextCursor: string | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(search);
  const go = (next: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (!v) q.delete(k);
      else q.set(k, v);
    }
    q.delete('cursor');
    router.push(`/admin/businesses${q.size ? `?${q}` : ''}`);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    go({ q: term.trim() || null });
  };
  const quiet = (iso: string | null) =>
    iso ? sinceWords(Math.round((Date.now() - Date.parse(iso)) / 60000)) : 'never';

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-xl font-semibold md:text-2xl">Businesses</h1>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {[
          { label: 'On HandsFreeOS', value: totals.businesses },
          { label: 'Signed up this week', value: totals.newThisWeek },
          { label: 'Did something this week', value: totals.activeThisWeek },
        ].map((s) => (
          <div key={s.label} className="rounded-card border border-border bg-card px-4 py-3">
            <dt className="text-[13px] text-text-3">{s.label}</dt>
            <dd className="mt-0.5 text-2xl font-semibold tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>

      <form onSubmit={submit} className="mt-5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search by business or agency name"
            aria-label="Search businesses"
            data-testid="business-search"
            className="pl-10"
          />
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => go({ sort: s.key === 'newest' ? null : s.key })}
            className={
              (sort || 'newest') === s.key
                ? 'h-8 rounded-control bg-accent-soft px-3 text-[13px] font-medium text-accent-text'
                : 'h-8 rounded-control px-3 text-[13px] font-medium text-text-2 hover:bg-card-2'
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-card border border-border bg-card">
        {businesses.map((b) => (
          <li key={b.workspaceId}>
            <Link
              href={`/admin/businesses/${b.workspaceId}`}
              className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3.5 hover:bg-card-2"
              data-testid={`business-row-${b.workspaceId}`}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{b.name}</span>
              <span className="text-[13px] text-text-3">
                {b.memberCount} {b.memberCount === 1 ? 'person' : 'people'}
              </span>
              <span className="text-[13px] text-text-3">· last active {quiet(b.lastActiveAt)}</span>
              {b.openTicketCount > 0 ? (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
                  {b.openTicketCount} open {b.openTicketCount === 1 ? 'ticket' : 'tickets'}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
        {businesses.length === 0 ? (
          <li className="px-4 py-10 text-center text-[13px] text-text-3">Nothing matches that.</li>
        ) : null}
      </ul>

      {nextCursor ? (
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => {
              const q = new URLSearchParams(params.toString());
              q.set('cursor', nextCursor);
              router.push(`/admin/businesses?${q}`);
            }}
            className="h-10 rounded-control border border-border px-4 text-sm font-medium hover:bg-card-2"
          >
            More
          </button>
        </div>
      ) : null}
    </div>
  );
}
