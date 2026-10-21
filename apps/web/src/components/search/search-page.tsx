'use client';
import {
  ADDON_CATALOG,
  dropdownOf,
  groupLabel,
  readSearchFragment,
  searchCount,
  searchKindsFor,
  searchPageHref,
  searchProbes,
  SEARCH_MIN_CHARS,
  SEARCH_WORDS as W,
  unavailableLine,
  type SearchGroup,
  type SearchHit,
  type SearchKindOutput,
  type SearchPageState,
} from '@hfos/core';
import { Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useWorkspaceShell } from '@/components/shell/workspace-shell';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { KindPage } from './kind-page';
import { NotAnswered, NothingFound, TopLine, TryAgainLine } from './panel';
import { PageRow, type RowContext } from './rows';
import { KIND_TILES, KindTile } from './rows/parts';
import { useSearchContext, type SearchContextValue } from './search-provider';
import { refusalOf, useSearch, useSettingsGroup } from './use-search';

/** The Search page lists this many of each kind; "Show 3 more contacts" reads that kind's first page in place. */
const PER_KIND = 4;
/** Tasks and notes share one card when together they have this many or fewer (board 2). */
const SHARED_CARD = 4;
/** What "Show more" reads in place: `search.kind`'s first page. */
const FIRST_PAGE = 50;

/** The kinds that get a wide card, with "Only contacts"; the rest sit in a grid of small ones (board 2). */
const wide = (kind: string) =>
  ['contacts', 'companies', 'leads', 'money', 'messages', 'spam'].includes(kind) ||
  kind.includes('.');

const EMPTY_STATE: SearchPageState = {
  q: '',
  kind: null,
  archived: false,
  mine: false,
  sort: 'best',
  show: null,
  before: null,
};

/**
 * The Search page (design/search/AllResults.dc.html, board 2), `/search#q=…&kind=…&archived=1&mine=1&sort=…&show=…`:
 * what's typed, and every switch, lives after `#` (decision 37), read here off `window.location.hash` when the page
 * opens and whenever it changes, and written back with `history.replaceState` a moment after typing stops, which the
 * router follows without a request. Nothing typed ever reaches the web's own server.
 *
 * Everything (`search.everything`, the full window) shows as a card for each kind in kind order, the kinds list beside
 * it with counts and a line for the kinds that found nothing; Settings, Archived and the Deleted bin come last. With
 * `kind=` the right side is that kind alone (`KindPage`). The empty, close-match and nobody-active lines are core's
 * `dropdownOf`'s, decided after the device's Settings group is merged in.
 *
 * What it knows about the business, and the person's recent searches, come from the layout's `SearchProvider`, as the
 * sidebar's box has them.
 */
export function SearchPage() {
  const search = useSearchContext();
  return search ? <Results business={search} /> : null;
}

function Results({ business }: { business: SearchContextValue }) {
  const { workspaceId } = business;
  const router = useRouter();
  const { permissions, addons } = useWorkspaceShell();
  const [state, setState] = useState<SearchPageState>(EMPTY_STATE);
  const [typed, setTyped] = useState('');
  const box = business.pageBoxRef;
  const root = useRef<HTMLDivElement>(null);

  // The address after `#`, when the page opens and whenever it changes (Back, or a link to another search).
  useEffect(() => {
    const read = () => {
      const next = readSearchFragment(window.location.hash);
      setState(next);
      setTyped(next.q);
    };
    read();
    window.addEventListener('hashchange', read);
    window.addEventListener('popstate', read);
    return () => {
      window.removeEventListener('hashchange', read);
      window.removeEventListener('popstate', read);
    };
  }, []);

  /** Changes the page's state and the address after `#` with it: a new kind is a step Back undoes, the rest isn't. */
  function update(patch: Partial<SearchPageState>, step: 'push' | 'replace' = 'replace') {
    const next = { ...state, ...patch };
    const href = searchPageHref(workspaceId, next);
    if (step === 'push') window.history.pushState(null, '', href);
    else window.history.replaceState(null, '', href);
    setState(next);
  }

  // What's typed goes into the address, and is searched, a moment after typing stops.
  useEffect(() => {
    const q = typed.trim().slice(0, 120);
    if (q === state.q) return;
    const timer = window.setTimeout(() => update({ q, before: null }), 300);
    return () => window.clearTimeout(timer);
  }, [typed, state]);

  const settingsOf = useSettingsGroup(business);
  const s = useSearch(
    workspaceId,
    {
      q: state.q,
      depth: 'full',
      perKind: PER_KIND,
      includeArchived: !!state.archived,
      onlyMine: !!state.mine,
    },
    settingsOf,
    { debounceMs: 0 },
  );
  const d = useMemo(
    () => (s.answer ? dropdownOf(s.answer, s.settings, { maxGroups: 99, maxRows: 9999 }) : null),
    [s.answer, s.settings],
  );
  const probes = useMemo(() => searchProbes(s.q), [s.q]);
  const ctx: RowContext = { probes, now: Date.now(), timeZone: business.timeZone };
  const searching = state.q.length >= SEARCH_MIN_CHARS;

  // The groups by kind, the Settings group among them; the cards and the kinds list follow the chips' order.
  const byKind = useMemo(() => {
    const all = [...(s.answer?.groups ?? []), ...(s.settings ? [s.settings] : [])];
    return new Map(all.map((g) => [g.kind, g]));
  }, [s.answer, s.settings]);
  const found = (d?.chips.slice(1) ?? [])
    .map((c) => byKind.get(c.kind))
    .filter((g): g is SearchGroup => !!g);
  const archived = s.answer?.archived?.items.length ? s.answer.archived : null;
  const bin = s.answer?.bin?.items.length ? s.answer.bin : null;
  // The kinds that didn't answer, the bin among them, each with its line and Try again.
  const unavailable = d?.unavailable ?? [];
  // The kinds this person may look in that found nothing this time, the running add-ons' among them: "Nothing in
  // Knowledge." Not when nothing at all was found: the empty state says so. An add-on that couldn't answer has one
  // line for all its kinds, under its own id.
  const running = useMemo(() => ADDON_CATALOG.filter((m) => addons.includes(m.id)), [addons]);
  const nothingIn =
    d && d.total > 0 && d.line !== 'close'
      ? searchKindsFor({ permissions, addons: running })
          .filter(
            (k) =>
              k.chip &&
              k.label &&
              !found.some((g) => g.kind === k.key) &&
              !(k.key === 'bin' && bin) &&
              !unavailable.some((g) => g.kind === k.key || k.key.startsWith(`${g.kind}.`)),
          )
          .map((k) => k.label!)
      : [];

  const remember = () => business.remember(state.q);
  const go = (href: string) => {
    remember();
    router.push(href);
  };

  // ↑ and ↓ move through the kinds list and the results; ↵ opens what has focus, as any link does.
  function onKeys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('[data-search-nav]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && e.target !== box.current) return;
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
    if (next < 0) box.current?.focus();
    else items[Math.min(next, items.length - 1)]?.focus();
  }

  const kindLink = (kind: string | null, label: string, count?: { n: number; capped: boolean }) => {
    const current = (state.kind ?? null) === kind;
    return (
      <a
        key={kind ?? 'all'}
        href={searchPageHref(workspaceId, {
          ...state,
          kind,
          sort: 'best',
          show: null,
          before: null,
        })}
        aria-current={current ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          update({ kind, sort: 'best', show: null, before: null }, 'push');
        }}
        data-search-nav
        data-testid={`search-kind-${kind ?? 'all'}`}
        className={cn(
          'flex h-[34px] flex-none items-center gap-2.5 whitespace-nowrap rounded-control px-2.5 text-sm font-medium transition-colors focus-visible:outline-none',
          current
            ? 'bg-accent-soft text-accent-text'
            : 'text-text-2 hover:bg-card-2 hover:text-text focus-visible:bg-card-2',
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {count ? (
          <span
            className={cn(
              'ml-auto text-[12.5px] tabular-nums',
              current ? 'text-accent-text' : 'text-text-3',
            )}
          >
            {searchCount(count.n, count.capped)}
          </span>
        ) : null}
      </a>
    );
  };

  const nav = (
    <nav
      aria-label={W.kindsOfResults}
      // A row of kinds that scrolls sideways on a phone, a list beside the results from `md`.
      className="flex w-full gap-0.5 overflow-x-auto rounded-card border border-border bg-card p-2 shadow-1 md:max-w-[240px] md:flex-[1_1_200px] md:flex-col md:overflow-visible"
      data-testid="search-kinds"
    >
      {d ? kindLink(null, d.chips[0]!.label, { n: d.total, capped: d.capped }) : null}
      {found.map((g) => kindLink(g.kind, groupLabel(g), { n: g.total, capped: g.capped }))}
      {archived
        ? kindLink('archived', groupLabel(archived), { n: archived.total, capped: archived.capped })
        : null}
      {bin ? kindLink('bin', groupLabel(bin), { n: bin.total, capped: bin.capped }) : null}
      {state.kind &&
      !found.some((g) => g.kind === state.kind) &&
      !(state.kind === 'archived' && archived) &&
      !(state.kind === 'bin' && bin)
        ? kindLink(
            state.kind,
            groupLabel(byKind.get(state.kind) ?? { kind: state.kind, label: null }),
          )
        : null}
      {nothingIn.length ? (
        <div className="hidden md:block">
          <div className="mx-1 my-1.5 h-px bg-border" />
          <p
            className="mx-2.5 mb-1.5 mt-0.5 text-[12.5px] text-text-3"
            data-testid="search-nothing-in"
          >
            {W.nothingIn(nothingIn)}
          </p>
        </div>
      ) : null}
    </nav>
  );

  return (
    <div ref={root} onKeyDown={onKeys} data-testid="search-page">
      <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em] md:text-2xl">
        {W.page}
      </h1>
      <p className="mb-4 mt-1 text-[13px] text-text-2">{W.everythingIn(business.name)}</p>
      <form
        role="search"
        className="relative max-w-[720px]"
        onSubmit={(e) => {
          e.preventDefault();
          const q = typed.trim().slice(0, 120);
          if (q !== state.q) update({ q, before: null });
          business.remember(q);
        }}
      >
        <Search
          className="pointer-events-none absolute left-[13px] top-[13px] h-[18px] w-[18px] text-text-3"
          strokeWidth={1.5}
          aria-hidden
        />
        <input
          ref={box}
          type="search"
          value={typed}
          autoFocus
          placeholder={W.box}
          aria-label={W.box}
          autoComplete="off"
          spellCheck={false}
          maxLength={120}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="search-page-input"
          className="h-11 w-full rounded-control border border-border-strong bg-card pl-10 pr-10 text-[15px] text-text placeholder:text-placeholder focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-ring [&::-webkit-search-cancel-button]:hidden"
        />
        {s.loading ? (
          <Loader2
            className="absolute right-3 top-[13px] h-[18px] w-[18px] animate-spin text-text-3"
            strokeWidth={1.75}
            aria-hidden
          />
        ) : null}
      </form>

      {!searching ? null : state.kind ? (
        <KindPage
          key={state.kind}
          business={business}
          state={state}
          update={update}
          nav={nav}
          settingsOf={settingsOf}
          everything={
            byKind.get(state.kind) ??
            (state.kind === 'archived' ? archived : state.kind === 'bin' ? bin : null)
          }
          onOpen={remember}
        />
      ) : (
        <>
          <div className="mb-5 mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2">
            {d ? (
              <span
                className="text-[14px] font-semibold"
                role="status"
                data-testid="search-results-for"
              >
                {W.resultsFor(d.total, s.q, d.capped)}
              </span>
            ) : null}
            <Checkbox
              label={W.includeArchived}
              checked={!!state.archived}
              onChange={(e) => update({ archived: e.target.checked })}
              className="text-[13px] text-text-2"
              data-testid="search-include-archived"
            />
            <Checkbox
              label={W.onlyMine}
              checked={!!state.mine}
              onChange={(e) => update({ mine: e.target.checked })}
              className="text-[13px] text-text-2"
              data-testid="search-only-mine"
            />
          </div>

          <div className="flex flex-wrap items-start gap-5">
            {nav}
            <div
              className="flex min-w-0 flex-[999_1_520px] flex-col gap-4"
              data-testid="search-results"
            >
              {d && (d.line === 'close' || d.line === 'none_active') ? (
                <Card>
                  <TopLine line={d.line} q={s.q} />
                  <div className="h-2.5" />
                </Card>
              ) : null}
              {s.refusal || unavailable.length ? (
                <Card>
                  <NotAnswered refusal={s.refusal} unavailable={unavailable} onRetry={s.retry} />
                </Card>
              ) : null}
              {d?.line === 'empty' && !s.refusal ? (
                <Card>
                  <NothingFound workspaceId={workspaceId} q={s.q} onGo={go} />
                </Card>
              ) : null}
              <Cards
                workspaceId={workspaceId}
                q={s.q}
                groups={found}
                archived={archived}
                bin={bin}
                state={state}
                ctx={ctx}
                settingsAll={s.settings}
                onOnly={(kind) => update({ kind, sort: 'best', show: null, before: null }, 'push')}
                onOpen={remember}
                onRetry={s.retry}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Every kind's card: the wide ones first in their order, then a grid of the small ones, Settings, Archived and the bin last. */
function Cards({
  workspaceId,
  q,
  groups,
  archived,
  bin,
  state,
  ctx,
  settingsAll,
  onOnly,
  onOpen,
  onRetry,
}: {
  workspaceId: string;
  /** What the answer on screen was for. */
  q: string;
  groups: readonly SearchGroup[];
  archived: SearchGroup | null;
  bin: SearchGroup | null;
  state: SearchPageState;
  ctx: RowContext;
  settingsAll: SearchGroup | null;
  onOnly: (kind: string) => void;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const tasks = groups.find((g) => g.kind === 'tasks');
  const notes = groups.find((g) => g.kind === 'notes');
  // Tasks and notes together in one small card, when there are few enough of both (board 2).
  const shared = !!tasks && !!notes && tasks.total + notes.total <= SHARED_CARD;
  const settings = groups.find((g) => g.kind === 'settings') ?? null;
  const rest = groups.filter((g) => g.kind !== 'settings' && !(shared && g.kind === 'notes'));
  const card = (g: SearchGroup, mixed?: SearchGroup) => (
    <GroupCard
      key={g.kind}
      workspaceId={workspaceId}
      q={q}
      group={g}
      mixed={mixed}
      state={state}
      ctx={ctx}
      settingsAll={g.kind === 'settings' ? settingsAll : null}
      onOnly={onOnly}
      onOpen={onOpen}
      onRetry={onRetry}
    />
  );
  const small = [
    ...rest
      .filter((g) => !wide(g.kind))
      .map((g) => (shared && g === tasks ? card(g, notes) : card(g))),
    ...(settings ? [card(settings)] : []),
    ...(archived ? [card(archived)] : []),
    ...(bin ? [card(bin)] : []),
  ];
  return (
    <>
      {rest.filter((g) => wide(g.kind)).map((g) => card(g))}
      {small.length ? (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
          {small}
        </div>
      ) : null}
    </>
  );
}

/** One kind's card: its heading and count, its rows, Show 3 more, and Only contacts on the wide ones. */
function GroupCard({
  workspaceId,
  q,
  group,
  mixed,
  state,
  ctx,
  settingsAll,
  onOnly,
  onOpen,
  onRetry,
}: {
  workspaceId: string;
  /** What the answer on screen was for: Show more reads on from it. */
  q: string;
  group: SearchGroup;
  /** The notes sharing the tasks' card. */
  mixed?: SearchGroup;
  state: SearchPageState;
  ctx: RowContext;
  /** Every setting that matched, which "Show more" lays out in place. */
  settingsAll: SearchGroup | null;
  onOnly: (kind: string) => void;
  onOpen: () => void;
  onRetry: () => void;
}) {
  // What Show more read, for the group it was read for: another search, or the same one asked again, is a new group,
  // so what this one read never shows under it, even when it lands after.
  const [more, setMore] = useState<{ for: SearchGroup; items: readonly SearchHit[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ for: SearchGroup; message: string } | null>(null);
  const label = mixed ? W.tasksAndNotes : groupLabel(group);
  const settings = group.kind === 'settings';
  const read = more?.for === group ? more.items : null;
  const failure = failed?.for === group ? failed.message : null;
  const items = read ?? (settings ? group.items.slice(0, PER_KIND) : group.items);
  const left = settings
    ? (settingsAll?.items.length ?? 0) - items.length
    : Math.min(group.total, FIRST_PAGE) - items.length;
  const addon =
    group.kind.includes('.') && !group.kind.startsWith('record.')
      ? (ADDON_CATALOG.find((m) => m.id === group.kind.split('.')[0])?.name ?? null)
      : null;
  const tile = KIND_TILES[group.kind];
  const unavailable = unavailableLine(group);

  async function showMore() {
    const asked = group;
    if (settings) {
      setMore({ for: asked, items: settingsAll?.items ?? group.items });
      return;
    }
    setBusy(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/search.kind', {
          body: {
            workspaceId,
            q,
            kind: group.kind,
            includeArchived: !!state.archived,
            onlyMine: !!state.mine,
            limit: FIRST_PAGE,
          },
        }),
      ) as SearchKindOutput;
      setMore({ for: asked, items: out.group.items });
      setFailed(null);
    } catch (e) {
      setFailed({ for: asked, message: refusalOf(e).message });
    } finally {
      setBusy(false);
    }
  }

  const rows: ReactNode[] = [
    ...items.map((hit, i) => (
      <PageRow
        key={`${group.kind}:${hit.kind}:${hit.id}`}
        hit={hit}
        ctx={{ ...ctx, icon: group.icon }}
        groupKind={group.kind}
        onOpen={onOpen}
        first={i === 0}
      />
    )),
    ...(mixed?.items ?? []).map((hit) => (
      <PageRow key={`notes:${hit.id}`} hit={hit} ctx={ctx} groupKind="notes" onOpen={onOpen} />
    )),
  ];

  return (
    <section
      className="rounded-card border border-border bg-card shadow-1"
      data-testid={`search-card-${group.kind}`}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        {wide(group.kind) && tile ? <KindTile icon={tile.icon} tone={tile.tone} /> : null}
        <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{label}</h2>
        <span className="text-[13px] text-text-3">
          {searchCount(group.total + (mixed?.total ?? 0), group.capped)}
        </span>
        {addon ? (
          <Badge variant="gray" className="ml-auto">
            {addon}
          </Badge>
        ) : null}
        {wide(group.kind) ? (
          <a
            href={searchPageHref(workspaceId, {
              ...state,
              kind: group.kind,
              sort: 'best',
              show: null,
              before: null,
            })}
            onClick={(e) => {
              e.preventDefault();
              onOnly(group.kind);
            }}
            className={cn(
              'text-[13px] font-medium text-accent-text hover:underline',
              !addon && 'ml-auto',
            )}
            data-testid={`search-only-${group.kind}`}
          >
            {W.only(label)}
          </a>
        ) : null}
      </div>
      {unavailable ? <TryAgainLine text={unavailable} onRetry={onRetry} /> : null}
      <div>{rows}</div>
      {failure ? <TryAgainLine text={failure} onRetry={() => void showMore()} /> : null}
      {left > 0 && !failure ? (
        <button
          type="button"
          onClick={() => void showMore()}
          disabled={busy}
          className="flex w-full items-center gap-2 rounded-b-card border-t border-border bg-card-2 px-4 py-2.5 text-left text-[13px] font-medium text-accent-text hover:underline disabled:opacity-60"
          data-testid={`search-more-${group.kind}`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} /> : null}
          {W.showMore(left, group.kind, groupLabel(group))}
        </button>
      ) : null}
    </section>
  );
}
