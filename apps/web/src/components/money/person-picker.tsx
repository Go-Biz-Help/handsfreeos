'use client';
import { NEW_CONTACT_WORDS } from '@hfos/core';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AddContactOption, useNewContact } from '@/components/crm/new-contact';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';

export interface PickedPerson {
  readonly id: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/**
 * Who a document is for. A person, not a company: an estimate is approved by someone, and a receipt goes to an
 * inbox. Companies come along through the person's record. Under what it finds, and when it finds nobody, it offers
 * to add what was typed as a new contact, who is then the one picked (`useNewContact`).
 */
export function PersonPicker({
  workspaceId,
  onPick,
  autoFocus,
  id = 'money-person',
}: {
  workspaceId: string;
  onPick: (person: PickedPerson) => void;
  autoFocus?: boolean;
  id?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedPerson[]>([]);
  const [open, setOpen] = useState(false);
  const [searched, setSearched] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const adding = useNewContact({
    workspaceId,
    onAdded: (c) => {
      setQ('');
      onPick(c);
    },
  });

  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/queries/person.list', {
            body: { workspaceId, q: query, limit: 8 },
          }),
        );
        if (cancelled) return;
        setResults(
          out.items.map((p) => ({
            id: p.id,
            fullName: p.fullName,
            email: p.email,
            phone: p.phone,
          })),
        );
        setSearched(true);
        setOpen(true);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, workspaceId]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const typed = q.trim();
  const offer = adding.canAdd && searched && typed.length >= 2;

  return (
    <div ref={box} className="relative w-full">
      <Search
        className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-3"
        strokeWidth={1.5}
      />
      <Input
        id={id}
        className="pl-9"
        placeholder="Type a name, phone or email"
        value={q}
        autoFocus={autoFocus}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => (results.length || searched) && setOpen(true)}
        data-testid="money-person-picker"
      />
      {open && (results.length > 0 || searched) ? (
        <ul
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-[260px] overflow-y-auto rounded-menu border border-border bg-card p-1.5 shadow-2"
          role="listbox"
        >
          {results.length === 0 ? (
            <li role="status" className="truncate px-2.5 py-2 text-[13px] text-text-3">
              {NEW_CONTACT_WORDS.nobody(typed)}
            </li>
          ) : null}
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-testid={`money-person-${p.fullName}`}
                onClick={() => {
                  onPick(p);
                  setOpen(false);
                  setQ('');
                }}
                className="flex w-full items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-left text-sm hover:bg-card-2 max-md:min-h-11"
              >
                <Avatar name={p.fullName} seed={p.id} size="sm" />
                <span className="truncate font-medium">{p.fullName}</span>
                <span className="truncate text-xs text-text-3">{p.email ?? p.phone ?? ''}</span>
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
