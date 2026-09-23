'use client';
import {
  articleFor,
  lowerLabel,
  otherSide,
  RELATIONSHIP_WORDS,
  type AddOption,
  type RelatableRecord,
} from '@hfos/core';
import { ArrowLeft, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { RecordIcon, RelatedMark } from './record-icon';

interface Found {
  readonly id: string;
  readonly name: string;
  readonly detail: string | null;
}

/** What the other end is called in a sentence: "pet", "customer", "company". */
const endWord = (o: AddOption) =>
  o.other.end === 'person'
    ? 'customer'
    : o.other.end === 'company'
      ? 'company'
      : lowerLabel(o.other.recordType?.singular ?? o.label);

/**
 * Relating another record to this one. Pick what to add (skipped when there's only one thing it could be), then
 * find it by name or make it on the spot: a new pet named as typed, a new customer, a new company.
 */
export function AddRelationshipDialog({
  workspaceId,
  record,
  options,
  initial,
  open,
  onOpenChange,
}: {
  workspaceId: string;
  record: RelatableRecord & { readonly id: string; readonly name: string };
  options: readonly AddOption[];
  initial: AddOption | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [option, setOption] = useState<AddOption | null>(initial);
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Look for the other end as it's typed: people, companies, or records of the one kind.
  useEffect(() => {
    if (!option) return;
    const query = q.trim();
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const api = apiBrowser();
        const list: Found[] =
          option.other.end === 'person'
            ? unwrap(
                await api.POST('/v1/queries/person.list', {
                  body: { workspaceId, q: query || undefined, limit: 8, sort: 'recent' },
                }),
              ).items.map((p) => ({ id: p.id, name: p.fullName, detail: p.phone ?? p.email }))
            : option.other.end === 'company'
              ? unwrap(
                  await api.POST('/v1/queries/company.list', {
                    body: { workspaceId, q: query || undefined, limit: 8 },
                  }),
                ).items.map((c) => ({ id: c.id, name: c.name, detail: c.phone ?? c.email }))
              : unwrap(
                  await api.POST('/v1/queries/custom_record.list', {
                    body: {
                      workspaceId,
                      typeId: option.other.recordType!.id,
                      q: query || undefined,
                      limit: 8,
                    },
                  }),
                ).items.map((r) => ({ id: r.id, name: r.name, detail: r.detail }));
        if (!cancelled) setFound(list.filter((f) => f.id !== record.id));
      } catch {
        if (!cancelled) setFound([]);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [option, q, workspaceId, record.id]);

  function choose(o: AddOption) {
    setOption(o);
    setQ('');
    setFound(null);
  }

  /** The pair's ends: this record on its side, the other on the other. */
  const ends = (o: AddOption, otherId: string) =>
    o.side === 'a' ? { aId: record.id, bId: otherId } : { aId: otherId, bId: record.id };

  async function relate(o: AddOption, other: { id: string; name: string }) {
    setBusy(true);
    try {
      unwrap(
        await apiBrowser().POST('/v1/commands/relationship.create', {
          body: {
            workspaceId,
            relationshipTypeId: o.typeId,
            ...ends(o, other.id),
            note: note.trim() || null,
          },
        }),
      );
      toast.success(`${other.name} added as ${articleFor(o.label)} ${lowerLabel(o.label)}.`);
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  /** Makes the other end from what was typed, then relates it (a record is made and related in one command). */
  async function createAndRelate(o: AddOption, name: string) {
    setBusy(true);
    try {
      const api = apiBrowser();
      if (o.other.end === 'custom_record') {
        unwrap(
          await api.POST('/v1/commands/custom_record.create', {
            body: {
              workspaceId,
              typeId: o.other.recordType!.id,
              name,
              relateTo: {
                relationshipTypeId: o.typeId,
                recordId: record.id,
                side: otherSide(o.side),
                note: note.trim() || null,
              },
            },
          }),
        );
        toast.success(`${name} added as ${articleFor(o.label)} ${lowerLabel(o.label)}.`);
        onOpenChange(false);
        router.refresh();
        return;
      }
      let id: string;
      if (o.other.end === 'person') {
        const [first, ...rest] = name.split(/\s+/);
        id = unwrap(
          await api.POST('/v1/commands/person.create', {
            body: { workspaceId, firstName: first ?? name, lastName: rest.join(' ') },
          }),
        ).personId;
      } else {
        id = unwrap(
          await api.POST('/v1/commands/company.create', { body: { workspaceId, name } }),
        ).companyId;
      }
      setBusy(false);
      await relate(o, { id, name });
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  }

  const typed = q.trim();
  const exact = found?.some((f) => f.name.trim().toLowerCase() === typed.toLowerCase());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={option ? `Add ${lowerLabel(option.label)}` : `Add to ${record.name}`}
        description={
          option
            ? `Find ${articleFor(endWord(option))} ${endWord(option)} already here, or add a new one.`
            : 'What would you like to connect?'
        }
      >
        {!option ? (
          <ul className="mt-4 flex flex-col gap-1.5" data-testid="relationship-options">
            {options.map((o) => (
              <li key={o.key}>
                <button
                  type="button"
                  disabled={o.full}
                  onClick={() => choose(o)}
                  data-testid={`relationship-option-${o.label}`}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-menu border border-border px-3 py-2.5 text-left hover:bg-card-2 disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  <RecordIcon
                    icon={
                      o.other.end === 'company'
                        ? 'building'
                        : o.other.end === 'custom_record'
                          ? o.other.recordType?.icon
                          : 'heart'
                    }
                    size="md"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium">{o.label}</span>
                    <span className="text-xs text-text-3">
                      {o.full
                        ? `${record.name} already has one.`
                        : o.other.end === 'custom_record'
                          ? (o.other.recordType?.plural ?? '')
                          : o.other.end === 'company'
                            ? 'A company'
                            : 'A customer'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 flex flex-col gap-3.5">
            {options.length > 1 && !initial ? (
              <button
                type="button"
                onClick={() => setOption(null)}
                className="inline-flex items-center gap-1.5 self-start text-[13px] text-accent-text hover:underline"
              >
                <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                Something else
              </button>
            ) : null}
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-text-3"
                strokeWidth={1.5}
              />
              <Input
                className="pl-9"
                placeholder={RELATIONSHIP_WORDS.searchPlaceholder}
                value={q}
                autoFocus
                autoComplete="off"
                aria-label={`Find ${articleFor(endWord(option))} ${endWord(option)}`}
                onChange={(e) => setQ(e.target.value)}
                data-testid="relationship-search"
              />
            </div>
            <ul
              className="flex max-h-[260px] flex-col gap-0.5 overflow-y-auto"
              data-testid="relationship-results"
            >
              {typed && !exact ? (
                <li>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void createAndRelate(option, typed)}
                    data-testid="relationship-create"
                    className="flex h-10 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm font-medium text-accent-text hover:bg-card-2 disabled:opacity-60"
                  >
                    <Plus className="h-4 w-4" strokeWidth={1.75} />
                    <span className="truncate">
                      {RELATIONSHIP_WORDS.createNew(typed, endWord(option))}
                    </span>
                  </button>
                </li>
              ) : null}
              {found === null ? (
                <li className="px-2.5 py-2 text-[13px] text-text-3">Looking…</li>
              ) : found.length === 0 ? (
                typed ? null : (
                  <li className="px-2.5 py-2 text-[13px] text-text-3">
                    {RELATIONSHIP_WORDS.noMatch}
                  </li>
                )
              ) : (
                found.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void relate(option, f)}
                      data-testid={`relationship-pick-${f.id}`}
                      className="flex h-10 w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-sm hover:bg-card-2 disabled:opacity-60"
                    >
                      <RelatedMark
                        kind={option.other.end}
                        id={f.id}
                        name={f.name}
                        icon={option.other.recordType?.icon}
                      />
                      <span className="truncate font-medium">{f.name}</span>
                      <span className="truncate text-xs text-text-3">{f.detail ?? ''}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <Field label={`${RELATIONSHIP_WORDS.note} (optional)`} htmlFor="relationship-new-note">
              <Input
                id="relationship-new-note"
                value={note}
                maxLength={200}
                placeholder={RELATIONSHIP_WORDS.notePlaceholder}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
