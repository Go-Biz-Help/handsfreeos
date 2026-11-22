'use client';
import { NEW_CONTACT_WORDS } from '@hfos/core';
import { Building2, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { AddContactOption, useNewContact } from './new-contact';

export interface PickedRecord {
  kind: 'person' | 'company';
  id: string;
  name: string;
  detail?: string | null;
}

/**
 * Search-as-you-type picker for a person or company (New lead from the pipeline, a deal's people, a new message).
 * Under what it finds, and when it finds nobody, it offers to add what was typed as a new contact, who is then the one
 * picked (`useNewContact`). `addNew={false}` leaves that out where the screen adds someone its own way (linking a
 * number or an email, whose own Add fills it in).
 */
export function RecordPicker({
  workspaceId,
  value,
  onChange,
  autoFocus,
  id,
  addNew = true,
}: {
  workspaceId: string;
  value: PickedRecord | null;
  onChange: (record: PickedRecord | null) => void;
  autoFocus?: boolean;
  id?: string;
  /** "Add “Dana Smith” as a new contact" under the results; on unless the screen adds someone its own way. */
  addNew?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedRecord[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const adding = useNewContact({
    workspaceId,
    enabled: addNew,
    onAdded: (c) => {
      setQ('');
      onChange({ kind: 'person', id: c.id, name: c.fullName, detail: c.phone ?? c.email });
    },
  });

  useEffect(() => {
    if (value) return;
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const [people, companies] = await Promise.all([
          apiBrowser()
            .POST('/v1/queries/person.list', {
              body: { workspaceId, q: query, limit: 6 },
            })
            .then(unwrap),
          apiBrowser()
            .POST('/v1/queries/company.list', {
              body: { workspaceId, q: query, limit: 4 },
            })
            .then(unwrap),
        ]);
        if (cancelled) return;
        setResults([
          ...people.items.map((p) => ({
            kind: 'person' as const,
            id: p.id,
            name: p.fullName,
            detail: p.company?.name ?? p.phone ?? p.email,
          })),
          ...companies.items.map((c) => ({
            kind: 'company' as const,
            id: c.id,
            name: c.name,
            detail: c.phone ?? c.email,
          })),
        ]);
        setOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, value, workspaceId]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  if (value)
    return (
      <>
        <div
          className="flex h-10 items-center gap-2.5 rounded-control border border-border-strong bg-card-2 px-3"
          data-testid="record-picker-value"
        >
          {value.kind === 'person' ? (
            <Avatar name={value.name} seed={value.id} size="sm" />
          ) : (
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-card-3 text-text">
              <Building2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{value.name}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-[13px] text-accent-text hover:underline"
          >
            Change
          </button>
        </div>
        {adding.dialog}
      </>
    );

  const typed = q.trim();
  const answered = !busy && typed.length >= 2;
  const offer = adding.canAdd && answered;
  return (
    <div ref={box} className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-3"
        strokeWidth={1.5}
      />
      <Input
        id={id}
        className="pl-9"
        placeholder="Type a name, phone or company"
        value={q}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        data-testid="record-picker"
      />
      {open && (results.length > 0 || answered) ? (
        <ul
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[260px] overflow-y-auto rounded-menu border border-border bg-card p-1.5 shadow-2"
          role="listbox"
        >
          {results.length === 0 ? (
            <li role="status" className="truncate px-2.5 py-2 text-[13px] text-text-3">
              {NEW_CONTACT_WORDS.nobody(typed)}
            </li>
          ) : null}
          {results.map((r) => (
            <li key={`${r.kind}-${r.id}`}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => {
                  onChange(r);
                  setOpen(false);
                  setQ('');
                }}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2',
                )}
              >
                {r.kind === 'person' ? (
                  <Avatar name={r.name} seed={r.id} size="sm" />
                ) : (
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-card-3 text-text">
                    <Building2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </span>
                )}
                <span className="truncate font-medium">{r.name}</span>
                <span className="truncate text-xs text-text-3">{r.detail ?? ''}</span>
              </button>
            </li>
          ))}
          {offer ? (
            <li className={results.length ? 'mt-1 border-t border-border pt-1' : undefined}>
              <AddContactOption
                typed={typed}
                onAdd={() => {
                  setOpen(false);
                  adding.begin(typed);
                }}
              />
            </li>
          ) : null}
        </ul>
      ) : null}
      {adding.dialog}
    </div>
  );
}
