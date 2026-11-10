'use client';
/**
 * Picking where a job is (the owner's decision 3): one of the business's properties, found by its address, or a new
 * address typed in, which becomes a property when the job is saved. With a customer picked, their properties are
 * offered first.
 */
import { MapPin, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { PropertyItem } from './types';

export type PickedProperty =
  | { readonly kind: 'existing'; readonly propertyId: string; readonly name: string }
  | { readonly kind: 'new'; readonly address: string };

export function PropertyPicker({
  workspaceId,
  id,
  value,
  onChange,
  customerPersonId,
  placeholder,
}: {
  workspaceId: string;
  id: string;
  value: PickedProperty | null;
  onChange: (next: PickedProperty | null) => void;
  customerPersonId: string | null;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<readonly PropertyItem[]>([]);

  useEffect(() => {
    if (value || !open) return;
    const search = q.trim();
    if (search.length < 2 && !customerPersonId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/contractor.property.list', {
            body: {
              workspaceId,
              ...(customerPersonId ? { customerPersonId } : {}),
              onlyTheirs: search.length < 2,
              ...(search.length >= 2 ? { search } : {}),
            },
          }),
        );
        if (!cancelled) setResults(out.properties.slice(0, 6));
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, open, value, workspaceId, customerPersonId]);

  if (value)
    return (
      <div className="flex h-10 items-center gap-2.5 rounded-control border border-border-strong bg-card-2 px-3">
        <MapPin className="h-4 w-4 flex-none text-text-3" />
        <span
          className="min-w-0 flex-1 truncate text-sm font-medium"
          data-testid="job-property-picked"
        >
          {value.kind === 'existing' ? value.name : value.address}
          {value.kind === 'new' ? <span className="ml-1.5 text-text-3">(new)</span> : null}
        </span>
        <button
          type="button"
          className="text-[13px] text-accent-text hover:underline"
          onClick={() => {
            onChange(null);
            setQ('');
          }}
        >
          Change
        </button>
      </div>
    );

  const typed = q.trim();
  const exact = results.some((r) => r.name.trim().toLowerCase() === typed.toLowerCase());
  return (
    <div className="relative">
      <Input
        id={id}
        value={q}
        maxLength={200}
        autoComplete="off"
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        data-testid="job-property"
      />
      {open && (results.length || typed.length >= 2) ? (
        <ul className="absolute left-0 right-0 top-full z-40 mt-1 rounded-menu border border-border bg-card p-1.5 shadow-2">
          {results.map((r) => (
            <li key={r.recordId}>
              <button
                type="button"
                className="flex min-h-9 w-full items-center justify-between gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-sm hover:bg-card-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange({ kind: 'existing', propertyId: r.recordId, name: r.name })}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  {r.owners.length ? (
                    <span className="block truncate text-xs text-text-3">
                      {r.owners.map((o) => o.name).join(', ')}
                    </span>
                  ) : null}
                </span>
                <span className="flex-none text-xs text-text-3">
                  {r.jobs === 1 ? '1 job' : `${r.jobs} jobs`}
                </span>
              </button>
            </li>
          ))}
          {typed.length >= 2 && !exact ? (
            <li>
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-[6px] px-2.5 text-left text-sm text-accent-text hover:bg-card-2"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onChange({ kind: 'new', address: typed })}
                data-testid="job-property-new"
              >
                <Plus className="h-4 w-4" />
                <span className="truncate">Add “{typed}” as a new property</span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** The property part of a job's input: the one picked, a new address, or neither. */
export function propertyInput(p: PickedProperty | null): {
  propertyId?: string | null;
  newPropertyAddress?: string;
} {
  if (!p) return {};
  return p.kind === 'existing' ? { propertyId: p.propertyId } : { newPropertyAddress: p.address };
}
