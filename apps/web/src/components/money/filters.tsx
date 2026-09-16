'use client';
import { Search } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { Input, Select } from '@/components/ui/input';
import type { FilterChoice, MoneyFilters } from './list-options';

/**
 * The search box and the status chips from the canvas. Typing waits 300 ms and then replaces the address, so
 * the server renders the filtered list and the Back button still works.
 */
export function MoneyFilterBar({
  filters,
  statuses,
  methods,
  searchLabel,
  count,
}: {
  filters: MoneyFilters;
  statuses?: readonly FilterChoice[];
  methods?: readonly FilterChoice[];
  /** Left out, the list's query has no search of its own and the box is hidden. */
  searchLabel?: string;
  count: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState(filters.q);

  function navigate(next: Partial<MoneyFilters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.q.trim()) params.set('q', merged.q.trim());
    if (merged.status) params.set('status', merged.status);
    if (merged.method) params.set('method', merged.method);
    const qs = params.toString();
    startTransition(() => router.replace(`${pathname}${qs ? `?${qs}` : ''}`));
  }

  useEffect(() => {
    if (q === filters.q) return;
    const timer = setTimeout(() => navigate({ q }), 300);
    return () => clearTimeout(timer);
  }, [q]);
  useEffect(() => setQ(filters.q), [filters.q]);

  return (
    <>
      {searchLabel ? (
        <div className="relative w-full sm:w-[220px]">
          <Search
            className="pointer-events-none absolute left-3 top-[9px] h-4 w-4 text-text-3"
            strokeWidth={1.5}
          />
          <Input
            inputSize="sm"
            className="pl-9"
            aria-label={searchLabel}
            placeholder={searchLabel}
            value={q}
            autoComplete="off"
            onChange={(e) => setQ(e.target.value)}
            data-testid="money-search"
          />
        </div>
      ) : null}
      {statuses ? (
        <Select
          selectSize="sm"
          className="w-auto"
          aria-label="Filter by status"
          value={filters.status}
          onChange={(e) => navigate({ status: e.target.value })}
          data-testid="money-status-filter"
        >
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
      ) : null}
      {methods ? (
        <Select
          selectSize="sm"
          className="w-auto"
          aria-label="Filter by how it was paid"
          value={filters.method}
          onChange={(e) => navigate({ method: e.target.value })}
          data-testid="money-method-filter"
        >
          {methods.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      ) : null}
      <span className="text-[13px] text-text-3" aria-live="polite" data-testid="money-count">
        {pending ? 'Updating…' : `${count} shown`}
      </span>
    </>
  );
}
