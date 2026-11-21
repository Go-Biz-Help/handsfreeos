'use client';
import { NEW_CONTACT_WORDS } from '@hfos/core';
import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AddContactOption, useNewContact } from '@/components/crm/new-contact';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';

export interface PickedCustomer {
  readonly id: string;
  readonly fullName: string;
  readonly detail?: string | null;
}

/**
 * Search-as-you-type for a person in Contacts (New appointment, a job's customer, a class's attendee). Under what it
 * finds, and when it finds nobody, it offers to add what was typed as a new contact, who is then the one picked
 * (`useNewContact`). `addNew={false}` leaves that out where a new contact makes no sense (merging, testing).
 */
export function CustomerPicker({
  workspaceId,
  value,
  onChange,
  id,
  locked,
  exceptId,
  addNew = true,
}: {
  workspaceId: string;
  value: PickedCustomer | null;
  onChange: (next: PickedCustomer | null) => void;
  id?: string;
  /** Opened from their page: shown, not changeable. */
  locked?: boolean;
  /** Left out of the results: the customer this is picked for (merging one into another). */
  exceptId?: string;
  /** "Add “Dana Smith” as a new contact" under the results; on unless a new contact makes no sense here. */
  addNew?: boolean;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedCustomer[]>([]);
  /** The search `results` answer, so nobody is said to be missing before the search has come back. */
  const [searched, setSearched] = useState('');
  const [open, setOpen] = useState(false);

  const reset = () => {
    setQ('');
    setResults([]);
    setSearched('');
  };
  const adding = useNewContact({
    workspaceId,
    enabled: addNew,
    onAdded: (c) => {
      reset();
      onChange({ id: c.id, fullName: c.fullName, detail: c.phone ?? c.email });
    },
  });

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
        if (!cancelled) {
          setResults(
            out.items
              .filter((p) => p.id !== exceptId)
              .map((p) => ({ id: p.id, fullName: p.fullName, detail: p.phone ?? p.email })),
          );
          setSearched(query);
        }
      } catch {
        if (!cancelled) {
          setResults([]);
          setSearched('');
        }
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, value, workspaceId, exceptId]);

  if (value)
    return (
      <>
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
                reset();
              }}
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </button>
          )}
        </div>
        {adding.dialog}
      </>
    );

  const typed = q.trim();
  /** The search for what's typed has come back. */
  const answered = typed.length >= 2 && searched === typed;
  const offer = adding.canAdd && answered;
  const add = () => {
    setOpen(false);
    adding.begin(typed);
  };

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
          if (e.target.value.trim().length < 2) {
            setResults([]);
            setSearched('');
          }
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
          {offer ? (
            <li className="mt-1 border-t border-border pt-1">
              <AddContactOption typed={typed} onAdd={add} />
            </li>
          ) : null}
        </ul>
      ) : null}
      {open && answered && !results.length ? (
        <div
          className="absolute inset-x-0 top-[44px] z-50 rounded-menu border border-border bg-card p-1 shadow-2"
          data-testid="customer-nobody"
        >
          <p
            role="status"
            className={cn(
              'truncate px-2.5 text-[13px] text-text-2',
              offer ? 'pb-1 pt-1.5' : 'py-1.5',
            )}
          >
            {NEW_CONTACT_WORDS.nobody(typed)}
          </p>
          {offer ? <AddContactOption typed={typed} onAdd={add} /> : null}
        </div>
      ) : null}
      {adding.dialog}
    </div>
  );
}
