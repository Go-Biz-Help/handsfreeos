'use client';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

export interface PickedCustomer {
  readonly id: string;
  readonly fullName: string;
  readonly detail?: string | null;
}

/** Search-as-you-type for a person in Customers (New appointment). */
export function CustomerPicker({
  workspaceId,
  value,
  onChange,
  id,
  locked,
  exceptId,
}: {
  workspaceId: string;
  value: PickedCustomer | null;
  onChange: (next: PickedCustomer | null) => void;
  id?: string;
  /** Opened from their page: shown, not changeable. */
  locked?: boolean;
  /** Left out of the results: the customer this is picked for (merging one into another). */
  exceptId?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const query = q.trim();
    if (value || query.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/person.list', {
            body: { workspaceId, q: query, limit: 6 },
          }),
        );
        if (!cancelled)
          setResults(
            out.items
              .filter((p) => p.id !== exceptId)
              .map((p) => ({ id: p.id, fullName: p.fullName, detail: p.phone ?? p.email })),
          );
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, value, workspaceId, exceptId]);

  if (value)
    return (
      <div
        className="flex h-10 min-w-0 items-center gap-2 rounded-control border border-border-strong bg-card px-3 text-[14.5px]"
        data-testid="appointment-customer"
      >
        <Avatar name={value.fullName} seed={value.id} size="sm" />
        <span className="min-w-0 flex-1 truncate">{value.fullName}</span>
        {locked ? null : (
          <button
            type="button"
            aria-label="Change customer"
            className="text-text-3 hover:text-text"
            onClick={() => {
              onChange(null);
              setQ('');
            }}
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        )}
      </div>
    );

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-[11px] h-[18px] w-[18px] text-text-3"
        strokeWidth={1.5}
      />
      <Input
        id={id}
        value={q}
        className="pl-[34px]"
        placeholder="Search by name or phone"
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          if (e.target.value.trim().length < 2) setResults([]);
        }}
      />
      {open && results.length ? (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-[44px] z-50 max-h-64 overflow-auto rounded-menu border border-border bg-card p-1 shadow-2"
        >
          {results.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-sm hover:bg-card-2',
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                }}
              >
                <Avatar name={r.fullName} seed={r.id} size="sm" />
                <span className="min-w-0 flex-1 truncate">{r.fullName}</span>
                {r.detail ? <span className="truncate text-xs text-text-3">{r.detail}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
