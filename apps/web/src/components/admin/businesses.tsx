'use client';
import {
  DESK_BUSINESS_SORTS,
  DESK_BUSINESS_WORDS,
  DESK_PLAN_WORDS,
  deskBusinessTotals,
  deskSectionLabel,
  type BusinessAttentionValue,
  type BusinessPlanValue,
} from '@hfos/core';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent, type MouseEvent } from 'react';
import { BusinessQuickLook, type QuickLookStaff } from '@/components/admin/business-quick-look';
import { Input } from '@/components/ui/input';

export interface BusinessRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly organizationName: string;
  readonly memberCount: number;
  readonly lastActiveAt: string | null;
  readonly openTicketCount: number;
  readonly createdAt: string;
  /** The founding offer whose seat is on this workspace, while it is. */
  readonly foundingSeat: string | null;
  readonly plan: BusinessPlanValue | null;
  /** What needs a look; empty when nothing does. */
  readonly attention: readonly BusinessAttentionValue[];
}

/** A plain click opens the quick look; a click meant for a new tab or window still opens the full page. */
const opensInPlace = (e: MouseEvent) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

/**
 * Every business on HandsFreeOS. The three numbers at the top are the ones Chris will look at daily. A business opens
 * in the quick look, over the list, and steps to the next from there.
 */
export function Businesses({
  businesses,
  totals,
  sort,
  search,
  nextCursor,
  staff,
}: {
  businesses: readonly BusinessRow[];
  totals: { businesses: number; newThisWeek: number; activeThisWeek: number };
  sort: string;
  search: string;
  nextCursor: string | null;
  staff: QuickLookStaff;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [term, setTerm] = useState(search);
  const [looking, setLooking] = useState<string | null>(null);
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

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="text-xl font-semibold md:text-2xl">{deskSectionLabel('businesses')}</h1>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        {deskBusinessTotals(totals).map((s) => (
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
            placeholder={DESK_BUSINESS_WORDS.searchPlaceholder}
            aria-label={DESK_BUSINESS_WORDS.searchLabel}
            data-testid="business-search"
            className="pl-10"
          />
        </div>
      </form>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {DESK_BUSINESS_SORTS.map((s) => (
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
              onClick={(e) => {
                if (!opensInPlace(e)) return;
                e.preventDefault();
                setLooking(b.workspaceId);
              }}
              className={
                looking === b.workspaceId
                  ? 'flex flex-wrap items-baseline gap-x-2 gap-y-1 bg-card-2 px-4 py-3.5'
                  : 'flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-3.5 hover:bg-card-2'
              }
              data-testid={`business-row-${b.workspaceId}`}
            >
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{b.name}</span>
              <span className="text-[13px] text-text-3">
                {DESK_BUSINESS_WORDS.people(b.memberCount)}
              </span>
              <span className="text-[13px] text-text-3">
                · {DESK_BUSINESS_WORDS.lastActive(b.lastActiveAt)}
              </span>
              {b.attention.length ? (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning-text">
                  {DESK_BUSINESS_WORDS.needsALook}
                </span>
              ) : null}
              {b.plan && !b.foundingSeat ? (
                <span className="rounded-full bg-card-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
                  {DESK_PLAN_WORDS[b.plan]}
                </span>
              ) : null}
              {b.foundingSeat ? (
                <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success-text">
                  {b.foundingSeat}
                </span>
              ) : null}
              {b.openTicketCount > 0 ? (
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text">
                  {DESK_BUSINESS_WORDS.openTickets(b.openTicketCount)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
        {businesses.length === 0 ? (
          <li className="px-4 py-10 text-center text-[13px] text-text-3">
            {DESK_BUSINESS_WORDS.nothingMatches}
          </li>
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
            {DESK_BUSINESS_WORDS.more}
          </button>
        </div>
      ) : null}

      <BusinessQuickLook
        rows={businesses}
        openId={looking}
        onOpen={setLooking}
        onClose={() => setLooking(null)}
        staff={staff}
      />
    </div>
  );
}
