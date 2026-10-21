'use client';
import {
  CONTACTS_WORDS,
  formatDate,
  groupLabel,
  searchHref,
  searchProbes,
  SEARCH_WORDS as W,
  unavailableLine,
  type SearchGroup,
  type SearchHit,
  type SearchKindOutput,
  type SearchPageState,
} from '@hfos/core';
import { Loader2, Users } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCan } from '@/components/shell/workspace-shell';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ButtonLink, Button } from '@/components/ui/button';
import { Select } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { Marked } from './highlight';
import { TryAgainLine } from './panel';
import { PageRow, rowView, type RowContext } from './rows';
import type { SearchBusiness } from './search-provider';
import { canRetry, isRetried, refusalOf, type SearchRefusal } from './use-search';

/** One kind's page reads this many at a time; Show 50 more reads the next. */
const PAGE = 50;

/** Hits in order, each once. */
const withoutRepeats = (hits: readonly SearchHit[]): SearchHit[] => {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const id = `${h.kind}:${h.id}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** Duplicate pairs in order, each once: each page brings the pairs on it. */
const pairsOnce = (pairs: SearchKindOutput['duplicates']): SearchKindOutput['duplicates'] => {
  const seen = new Set<string>();
  return pairs.filter((d) => {
    const id = [...d.ids].sort().join(':');
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

/** One page of one kind, and the pages before it this visit. */
interface Shown {
  readonly key: string;
  readonly group: SearchGroup;
  readonly items: readonly SearchHit[];
  readonly next: string | null;
  readonly standing: SearchKindOutput['standingCounts'];
  readonly duplicates: SearchKindOutput['duplicates'];
}

/**
 * One kind at a time (design/search/ManyMatches.dc.html, board 3): `search.kind` a page at a time, the kinds list kept
 * beside it to switch. Contacts get All · Leads · Clients, Sort, a table that tells same-name people apart, and the
 * banner when two share a number or an email; a windowed kind says how far back it looked and can look further; the
 * Messages page can look in Spam. Settings are worked out on the device, so their page is too.
 */
export function KindPage({
  business,
  state,
  update,
  nav,
  settingsOf,
  everything,
  onOpen,
}: {
  business: SearchBusiness;
  state: SearchPageState;
  /** Changes what the address says after `#`: a new kind or sort is a step Back can undo, the rest isn't. */
  update: (patch: Partial<SearchPageState>, step?: 'push' | 'replace') => void;
  /** The kinds list, drawn by the Search page from everything's answer. */
  nav: ReactNode;
  settingsOf: (q: string) => SearchGroup | null;
  /** This kind's group in everything's answer, for its name before its own page comes. */
  everything: SearchGroup | null;
  /** A result was opened: the search goes among the recent ones. */
  onOpen: () => void;
}) {
  const { workspaceId } = business;
  const kind = state.kind!;
  const q = state.q;
  const canMerge = useCan('records.archive');
  const settingsPage = kind === 'settings';
  const [shown, setShown] = useState<Shown | null>(null);
  const [loading, setLoading] = useState(false);
  const [refusal, setRefusal] = useState<SearchRefusal | null>(null);
  const [nonce, setNonce] = useState(0);
  // Look further back adds the older window's results under those already shown.
  const append = useRef(false);
  const key = JSON.stringify([
    workspaceId,
    q,
    kind,
    state.archived,
    state.mine,
    state.sort,
    state.show,
  ]);
  // The search on screen now, so a page read for an earlier one is dropped when it lands.
  const current = useRef(key);
  useEffect(() => {
    current.current = key;
  }, [key]);

  async function read(cursor: string | null) {
    return unwrap(
      await apiBrowser().POST('/v1/queries/search.kind', {
        body: {
          workspaceId,
          q,
          kind,
          includeArchived: !!state.archived,
          onlyMine: !!state.mine,
          sort: state.sort ?? 'best',
          ...(state.show ? { standing: state.show === 'leads' ? 'lead' : 'client' } : {}),
          ...(state.before ? { before: state.before } : {}),
          ...(cursor ? { cursor } : {}),
          limit: PAGE,
        },
      }),
    ) as SearchKindOutput;
  }

  useEffect(() => {
    if (settingsPage || q.length < 2) return;
    let cancelled = false;
    let quiet: number | undefined;
    const adding = append.current;
    append.current = false;
    const run = async (again: boolean) => {
      setLoading(true);
      try {
        const out = await read(null);
        if (cancelled) return;
        setRefusal(null);
        setShown((was) => {
          const more = adding && was?.key === key ? was : null;
          return {
            key,
            // The older window's count adds to what the newer ones found.
            group: more
              ? {
                  ...out.group,
                  total: more.group.total + out.group.total,
                  capped: more.group.capped || out.group.capped,
                }
              : out.group,
            // A thread with messages in both windows shows once, where it first showed.
            items: more ? withoutRepeats([...more.items, ...out.group.items]) : out.group.items,
            next: out.nextCursor,
            standing: out.standingCounts,
            duplicates: more ? pairsOnce([...more.duplicates, ...out.duplicates]) : out.duplicates,
          };
        });
      } catch (e) {
        if (cancelled) return;
        setRefusal(refusalOf(e));
        if (!again && isRetried(e)) quiet = window.setTimeout(() => void run(true), 2000);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run(false);
    return () => {
      cancelled = true;
      window.clearTimeout(quiet);
    };
    // `read` reads what the key names, and `before`, which only Look further back changes.
  }, [key, state.before, nonce, settingsPage]);

  async function more() {
    if (!shown?.next || shown.key !== key) return;
    const asked = shown;
    setLoading(true);
    try {
      const out = await read(asked.next);
      if (current.current !== asked.key) return;
      setShown((was) =>
        was?.key === asked.key && was.next === asked.next
          ? {
              ...was,
              items: withoutRepeats([...was.items, ...out.group.items]),
              next: out.nextCursor,
              // Pairs sharing a number on a later page get their banner too.
              duplicates: pairsOnce([...was.duplicates, ...out.duplicates]),
            }
          : was,
      );
      setRefusal(null);
    } catch (e) {
      if (current.current === asked.key) setRefusal(refusalOf(e));
    } finally {
      if (current.current === asked.key) setLoading(false);
    }
  }

  // Settings never leave the device: their page is the catalogue's whole answer.
  const settings = useMemo(
    () => (settingsPage ? settingsOf(q) : null),
    [settingsPage, settingsOf, q],
  );
  const group = settingsPage ? settings : shown?.key === key ? shown.group : null;
  const items = settingsPage ? (settings?.items ?? []) : shown?.key === key ? shown.items : [];
  const plural = groupLabel(group ?? everything ?? { kind, label: null });
  const contacts = kind === 'contacts';
  const probes = useMemo(() => searchProbes(q), [q]);
  const ctx: RowContext = {
    probes,
    now: Date.now(),
    timeZone: business.timeZone,
    icon: group?.icon ?? everything?.icon ?? null,
  };
  const total = group?.total ?? 0;
  const byName =
    items.length > 0 && items.every((h) => h.why.field === 'name' || h.why.field === 'title');
  const standing = shown?.key === key ? shown.standing : null;
  const duplicates = shown?.key === key ? shown.duplicates : [];
  const notAnswered = group ? unavailableLine(group) : null;

  return (
    <>
      <div className="mb-5 mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[14px] font-semibold" role="status" data-testid="search-kind-title">
          {/* A kind that didn't answer has its own line below, never "0 listings". */}
          {group && !(notAnswered && items.length === 0)
            ? byName
              ? W.named(total, kind, plural, q)
              : W.kindFor(total, kind, plural, q)
            : null}
        </span>
        {contacts && total > 5 && probes.words.length === 1 ? (
          <span className="text-[13px] text-text-2">{W.narrow}</span>
        ) : null}
        <Checkbox
          label={W.includeArchived}
          checked={!!state.archived}
          onChange={(e) => update({ archived: e.target.checked, before: null })}
          className="text-[13px] text-text-2"
        />
        <Checkbox
          label={W.onlyMine}
          checked={!!state.mine}
          onChange={(e) => update({ mine: e.target.checked, before: null })}
          className="text-[13px] text-text-2"
        />
      </div>

      <div className="flex flex-wrap items-start gap-5">
        {nav}
        <div
          className="flex min-w-0 flex-[999_1_520px] flex-col gap-3"
          data-testid="search-kind-page"
        >
          {contacts ? (
            <div className="flex flex-wrap items-center gap-2">
              <Segmented
                ariaLabel={CONTACTS_WORDS.standing}
                value={state.show ?? 'all'}
                onChange={(v) =>
                  update({ show: v === 'all' ? null : (v as 'leads' | 'clients'), before: null })
                }
                options={[
                  {
                    value: 'all',
                    label: standing
                      ? `${CONTACTS_WORDS.all} ${standing.leads + standing.clients}`
                      : CONTACTS_WORDS.all,
                    testId: 'search-standing-all',
                  },
                  {
                    value: 'leads',
                    label: standing
                      ? `${CONTACTS_WORDS.leads} ${standing.leads}`
                      : CONTACTS_WORDS.leads,
                    testId: 'search-standing-leads',
                  },
                  {
                    value: 'clients',
                    label: standing
                      ? `${CONTACTS_WORDS.clients} ${standing.clients}`
                      : CONTACTS_WORDS.clients,
                    testId: 'search-standing-clients',
                  },
                ]}
              />
              <label className="ml-auto flex items-center gap-2 text-[13px] text-text-2">
                {W.sort}
                <Select
                  selectSize="sm"
                  value={state.sort ?? 'best'}
                  onChange={(e) =>
                    update(
                      { sort: e.target.value as 'best' | 'recent' | 'name', before: null },
                      'push',
                    )
                  }
                  className="w-[190px]"
                  data-testid="search-sort"
                >
                  <option value="best">{W.sorts.best}</option>
                  <option value="recent">{W.sorts.recent}</option>
                  <option value="name">{W.sorts.name}</option>
                </Select>
              </label>
            </div>
          ) : null}

          {duplicates.map((d) => (
            <div
              key={d.ids.join(':')}
              className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-card border border-[color-mix(in_oklab,var(--warning)_35%,var(--border))] bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text"
              role="status"
              data-testid="search-duplicates"
            >
              <Users className="h-4 w-4 flex-none" strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 flex-[1_1_280px]">
                {d.on === 'phone' ? W.twoShare(d.name, d.value) : W.twoShareEmail(d.name, d.value)}
              </span>
              {canMerge ? (
                <ButtonLink
                  href={searchHref(workspaceId, {
                    type: 'merge',
                    personId: d.ids[0],
                    otherId: d.ids[1],
                  })}
                  variant="secondary"
                  size="sm"
                  data-testid="search-compare"
                >
                  {W.compareAndMerge}
                </ButtonLink>
              ) : null}
            </div>
          ))}

          {refusal ? (
            <Card>
              {canRetry(refusal) ? (
                <TryAgainLine text={refusal.message} onRetry={() => setNonce((n) => n + 1)} />
              ) : (
                <p className="px-4 py-3 text-[13px] text-text-2" role="status">
                  {refusal.message}
                </p>
              )}
            </Card>
          ) : null}

          <Card className={cn(contacts && 'overflow-x-auto')}>
            {notAnswered ? (
              <TryAgainLine text={notAnswered} onRetry={() => setNonce((n) => n + 1)} />
            ) : null}
            {!group && loading ? (
              <div className="flex justify-center py-10 text-text-3">
                <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.75} />
              </div>
            ) : contacts ? (
              <ContactsTable items={items} ctx={ctx} onOpen={onOpen} />
            ) : (
              items.map((hit, i) => (
                <PageRow
                  key={`${hit.kind}:${hit.id}`}
                  hit={hit}
                  ctx={ctx}
                  groupKind={kind}
                  onOpen={onOpen}
                  first={i === 0}
                />
              ))
            )}
            {group && items.length > 0 ? (
              <div
                className={cn(
                  'flex items-center justify-between gap-3 rounded-b-card border-t border-border bg-card-2 px-4 py-2.5 text-[13px] text-text-3',
                  contacts && 'min-w-[820px]',
                )}
                data-testid="search-kind-footer"
              >
                <span>
                  {shown?.next ? W.showingOf(items.length, total) : W.showingAll(items.length)}
                </span>
                {shown?.next ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={loading}
                    onClick={() => void more()}
                    data-testid="search-kind-more"
                  >
                    {W.showMoreOf(PAGE)}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Card>

          {/* Only a windowed kind says how far back it looked, Archived's threads included. */}
          {group?.searchedBack && !group.complete ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-2">
              <span data-testid="search-searched-back">
                {W.searchedBack(kind, plural, formatDate(group.searchedBack))}
              </span>
              <button
                type="button"
                className="font-medium text-accent-text hover:underline"
                onClick={() => {
                  append.current = true;
                  update({ before: group.searchedBack });
                }}
                data-testid="search-further-back"
              >
                {W.lookFurther}
              </button>
            </div>
          ) : null}
          {kind === 'messages' ? (
            <button
              type="button"
              className="self-start text-[13px] font-medium text-accent-text hover:underline"
              onClick={() => update({ kind: 'spam', before: null }, 'push')}
              data-testid="search-look-in-spam"
            >
              {W.lookInSpam}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Contacts in a table that tells same-name people apart: name (badge, open lead or company), phone, email, where, last contact. */
function ContactsTable({
  items,
  ctx,
  onOpen,
}: {
  items: readonly SearchHit[];
  ctx: RowContext;
  onOpen: () => void;
}) {
  const grid =
    'grid min-w-[820px] grid-cols-[minmax(240px,1.7fr)_minmax(130px,1fr)_minmax(150px,1.1fr)_minmax(130px,1fr)_minmax(130px,1fr)] items-center gap-x-4 px-4';
  const cell = 'min-w-0 truncate text-[13px]';
  return (
    <div data-testid="search-contacts-table">
      <div
        className={cn(
          grid,
          'h-9 border-b border-border text-[12px] font-medium uppercase tracking-[0.04em] text-text-3',
        )}
      >
        <span>{W.columns.name}</span>
        <span>{W.columns.phone}</span>
        <span>{W.columns.email}</span>
        <span>{W.columns.where}</span>
        <span>{W.columns.lastContact}</span>
      </div>
      {items.map((hit, i) => {
        const view = rowView(hit, ctx, 'contacts');
        const f = hit.facts;
        const [, , last] = view.columns ?? [];
        const value = (text: string | undefined | null) =>
          text ? (
            <span className={cn(cell, 'text-text-2')}>
              <Marked text={text} probes={ctx.probes} />
            </span>
          ) : (
            <span className={cn(cell, 'text-text-3')}>—</span>
          );
        return (
          <Link
            key={hit.id}
            href={hit.href}
            onClick={onOpen}
            data-search-nav
            data-testid="search-row-contacts"
            data-hit={hit.id}
            className={cn(
              grid,
              'min-h-12 py-[7px] text-text transition-colors hover:bg-card-2 focus-visible:bg-card-2 focus-visible:outline-none',
              i > 0 && 'border-t border-border',
            )}
          >
            <span className="flex min-w-0 items-center gap-3">
              {view.leading}
              <span className="flex min-w-0 flex-col">
                <span className="text-[14px] font-medium">{view.title}</span>
                {view.under ? (
                  <span className="truncate text-[12.5px] text-text-3">{view.under}</span>
                ) : null}
              </span>
            </span>
            {value(f.phone)}
            {value(f.email)}
            {value(f.where)}
            {last ? (
              <span className={cn(cell, 'text-text-2')}>{last}</span>
            ) : (
              <span className={cn(cell, 'text-text-3')}>—</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
