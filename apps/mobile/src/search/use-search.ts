import {
  copyKindsFor,
  copyWantsClose,
  searchCopy,
  searchProbes,
  settingsSearchGroup,
  SEARCH_KIND_LABELS,
  type SearchEverythingOutput,
  type SearchGroup,
  type SearchHit,
  type SearchKindOutput,
  type SearchSource,
} from '@hfos/core';
import { usePowerSync } from '@powersync/react-native';
import * as React from 'react';

import { PHONE_ADDONS } from '@/addons/registry';
import { useSettled } from '@/components/admin/bits';
import { useBusiness } from '@/components/shell/business-context';
import { api, ApiError, errorMessage, unwrap } from '@/lib/api';
import { useGrants } from '@/lib/grants';
import { useNetwork } from '@/lib/network';
import { usePhoneSettings } from '@/settings/settings-search';

import { readCloseNames, readCopy, type CopyAsk, type CopyDb } from './copy-sql';

/**
 * Search everything on the phone (HANDSFREEOS_SEARCH_IMPLEMENTATION_PLAN.md, "Phone: search" and "Phone: no signal",
 * decision 10): with signal, HandsFreeOS's answer, asked 300 ms after the typing stops with what's typed in the
 * request's body only; the phone's own rows show at once, marked "On this phone", and the server's answer takes their
 * place. With no signal, or when a request fails for want of it, core's `searchCopy` searches the phone's copy and the
 * screen says so. Settings are searched on the phone either way, and a setting that matched means no close matches
 * are looked for. A stale answer is dropped, a refusal HandsFreeOS says to retry is asked once more after 2 s, and
 * everything is asked again when signal comes back. Viewing as a teammate, the server answers as them, and with no
 * signal only settings are searched: the copy is the viewer's, not theirs.
 */

/** How long the typing has to stop before a search is asked. */
export const SEARCH_SETTLE_MS = 300;
/** How long before one quiet retry of a refusal HandsFreeOS says to retry (busy, too slow, too fast). */
const RETRY_MS = 2_000;
/** One kind's page on the phone, and each Show 25 more. */
export const KIND_PAGE = 25;
/** Hits a kind in the box, and in "See all 26 results", every group at once. */
const BOX_PER_KIND = 3;
export const FULL_PER_KIND = 5;

/** An answer on screen, and where it came from. */
export type PhoneAnswer = SearchEverythingOutput & { readonly source: SearchSource };

/** Whether the phone knows how to draw a group's kind: core's own, a business's own kinds, and an add-on's. */
export function knownKind(kind: string): boolean {
  // Core's own labels only: `in` would take an object's own keys ("constructor") for kinds.
  return Object.prototype.hasOwnProperty.call(SEARCH_KIND_LABELS, kind) || kind.includes('.');
}

/**
 * Whether the phone searches a kind in its own copy with no signal: core's kinds it keeps that this person may search,
 * and the kinds an add-on's own search answers from its part of the copy (Real Estate's Deals). The rest (Messages,
 * Money, Files, Knowledge, a business's own kinds, Real Estate's Listings, Homes and Properties) wait for signal.
 */
export function searchedOffline(kind: string, permissions: readonly string[]): boolean {
  return (
    copyKindsFor(permissions, [kind]).length > 0 ||
    PHONE_ADDONS.some(
      (a) => !!a.search && permissions.includes(a.permission) && !!a.searchKinds?.includes(kind),
    )
  );
}

/**
 * Whether the phone can draw a group: a kind it knows, or one that only says it didn't answer, in its own words (an
 * add-on that couldn't be searched is named by its id, `realestate`, with its name as the label).
 */
const drawable = (g: SearchGroup): boolean =>
  knownKind(g.kind) || (!!g.unavailable && g.items.length === 0 && !!g.label);

/** An answer without the groups this build doesn't know (an older build skips a kind it doesn't know). */
function knownOnly(a: SearchEverythingOutput): SearchEverythingOutput {
  const groups = a.groups.filter(drawable);
  if (groups.length === a.groups.length) return a;
  return {
    ...a,
    groups,
    total: groups.reduce((n, g) => n + g.total, 0),
    best: a.best && knownKind(a.best.kind) ? a.best : null,
  };
}

/** The main search's Settings group, worked out on the phone from core's catalogue, as Settings search does. */
export function useSettingsGroup(q: string): SearchGroup | null {
  const { business } = useBusiness();
  const { hits, settings } = usePhoneSettings(q);
  return React.useMemo(
    () =>
      searchProbes(q).tooShort
        ? null
        : settingsSearchGroup(business.id, hits, {
            settings,
            timeZone: business.timezone || 'UTC',
          }),
    [q, hits, settings, business.id, business.timezone],
  );
}

/** What a search reads from the copy, for this person and these chips. */
function useCopyAsk(q: string, kinds: readonly string[] | null): CopyAsk {
  const { business, me } = useBusiness();
  const { permissions } = useGrants();
  return React.useMemo(
    () => ({
      workspaceId: business.id,
      userId: me.user.id,
      q,
      now: Date.now(),
      timeZone: business.timezone || 'UTC',
      permissions: permissions ?? [],
      kinds,
    }),
    [business.id, business.timezone, me.user.id, q, permissions, kinds],
  );
}

/** The phone's own answer: the copy's rows, then the names for close matches when nothing matched. */
async function answerFromCopy(
  db: CopyDb,
  ask: CopyAsk,
  more: { perKind: number; settingsMatched: boolean },
): Promise<PhoneAnswer> {
  const rows = await readCopy(db, ask);
  const opts = { ...ask, perKind: more.perKind, settingsMatched: more.settingsMatched };
  const answer = searchCopy(ask.q, rows, opts);
  if (!copyWantsClose(answer, more.settingsMatched)) return answer;
  return searchCopy(ask.q, { ...rows, close: await readCloseNames(db, ask) }, opts);
}

/** A request that failed for want of signal (a fetch's TypeError), not a refusal. */
const noSignal = (e: unknown) => e instanceof TypeError;
const aborted = (e: unknown) => e instanceof Error && e.name === 'AbortError';
/**
 * Whether Try again can help a failed search: a refusal that passes (busy, too slow, too fast) or a failure with no
 * refusal at all. Not one saying the person may not look there, or that the kind is gone, as the web decides.
 */
const retryable = (e: unknown) => !(e instanceof ApiError) || e.disposition === 'retry';

export interface EverythingState {
  /** What was searched: the typing, once it settled. */
  readonly q: string;
  readonly answer: PhoneAnswer | null;
  /** The Settings group the phone found, or null. */
  readonly settings: SearchGroup | null;
  readonly loading: boolean;
  /** HandsFreeOS's refusal, in its words. */
  readonly error: string | null;
  /** Whether Try again can help the refusal. */
  readonly canRetry: boolean;
  /** No signal: the answer is the phone's own, and the screen says so. */
  readonly offline: boolean;
  /** Viewing as a teammate with no signal: only settings are searched. */
  readonly viewingOffline: boolean;
  retry(): void;
}

/** Search everything, for the box (`full` false: a few a kind) or every group at once (`full`). */
export function useEverything(
  typed: string,
  opts: { readonly kinds?: readonly string[] | null; readonly full?: boolean } = {},
): EverythingState {
  const { business, viewing } = useBusiness();
  const db = usePowerSync();
  const { online } = useNetwork();
  const q = useSettled(typed, SEARCH_SETTLE_MS);
  const settings = useSettingsGroup(q);
  const settingsMatched = settings !== null;
  const kinds = opts.kinds?.length ? opts.kinds : null;
  const ask = useCopyAsk(q, kinds);
  const full = opts.full ?? false;
  const perKind = full ? FULL_PER_KIND : BOX_PER_KIND;
  const [round, setRound] = React.useState(0);
  const retried = React.useRef<string | null>(null);
  const [state, setState] = React.useState<{
    key: string;
    answer: PhoneAnswer | null;
    loading: boolean;
    error: string | null;
    canRetry: boolean;
    offline: boolean;
  }>({ key: '', answer: null, loading: false, error: null, canRetry: true, offline: false });

  const key = JSON.stringify([q, kinds, full, settingsMatched, online, !!viewing]);
  React.useEffect(() => {
    if (searchProbes(q).tooShort) {
      setState({
        key,
        answer: null,
        loading: false,
        error: null,
        canRetry: true,
        offline: !online,
      });
      return;
    }
    let live = true;
    let answered = false;
    const show = (s: Partial<typeof state>) => live && setState((was) => ({ ...was, key, ...s }));
    const fromCopy = (offline: boolean) =>
      answerFromCopy(db, ask, { perKind, settingsMatched })
        .then((answer) => {
          if (!answered) show({ answer, loading: false, error: null, offline });
        })
        .catch(() => show({ loading: false, offline }));

    // No signal: the phone's own copy, or, viewing as someone, settings alone.
    if (!online) {
      if (viewing) show({ answer: null, loading: false, error: null, offline: true });
      else void fromCopy(true);
      return () => {
        live = false;
      };
    }

    // With signal: the phone's own rows at once (not while viewing as someone), then the server's in their place.
    const controller = new AbortController();
    show({ loading: true, error: null, offline: false });
    if (!viewing) void fromCopy(false);
    api
      .POST('/v1/queries/search.everything', {
        body: {
          workspaceId: business.id,
          q,
          ...(kinds ? { kinds: [...kinds] } : {}),
          perKind,
          depth: full ? 'full' : 'quick',
          settingsMatched,
        },
        signal: controller.signal,
      })
      // The client's types can't say a mark is a pair; the answer is core's own shape.
      .then((r) => unwrap(r) as SearchEverythingOutput)
      .then((a) => {
        answered = true;
        show({ answer: { ...knownOnly(a), source: 'server' }, loading: false, error: null });
      })
      .catch((e: unknown) => {
        if (!live || aborted(e)) return;
        if (noSignal(e)) {
          if (viewing) show({ answer: null, loading: false, offline: true });
          else void fromCopy(true);
          return;
        }
        if (e instanceof ApiError && e.disposition === 'retry' && retried.current !== q) {
          retried.current = q;
          setTimeout(() => live && setRound((r) => r + 1), RETRY_MS);
          return;
        }
        show({ loading: false, error: errorMessage(e), canRetry: retryable(e) });
      });
    return () => {
      live = false;
      controller.abort();
    };
    // `key` holds everything else the search depends on.
  }, [key, ask, round]);

  const current = state.key === key;
  return {
    q,
    answer: current ? state.answer : null,
    settings,
    loading: current ? state.loading : !searchProbes(q).tooShort,
    error: current ? state.error : null,
    canRetry: current ? state.canRetry : true,
    offline: !online || (current && state.offline),
    viewingOffline: !!viewing && (!online || (current && state.offline)),
    retry: React.useCallback(() => setRound((r) => r + 1), []),
  };
}

export interface OneKindState {
  readonly q: string;
  /** The kind's group, its items every page shown so far. */
  readonly group: SearchGroup | null;
  readonly source: SearchSource | null;
  readonly standingCounts: SearchKindOutput['standingCounts'];
  readonly duplicates: SearchKindOutput['duplicates'];
  readonly more: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error: string | null;
  /** Whether Try again can help the refusal. */
  readonly canRetry: boolean;
  readonly offline: boolean;
  readonly viewingOffline: boolean;
  showMore(): void;
  retry(): void;
}

/**
 * One kind, 25 at a time with Show 25 more; contacts can be kept to leads or clients. With no signal, the copy's. A
 * refusal HandsFreeOS says to retry is asked once more after 2 s, the first page's and Show 25 more's alike.
 */
export function useOneKind(
  typed: string,
  kind: string,
  standing: 'lead' | 'client' | null,
): OneKindState {
  const { business, viewing } = useBusiness();
  const db = usePowerSync();
  const { online } = useNetwork();
  const q = useSettled(typed, SEARCH_SETTLE_MS);
  const kinds = React.useMemo(() => [kind], [kind]);
  const ask = useCopyAsk(q, kinds);
  const [round, setRound] = React.useState(0);
  const retried = React.useRef<string | null>(null);
  const [state, setState] = React.useState<{
    key: string;
    page: SearchKindOutput | null;
    items: SearchHit[];
    source: SearchSource | null;
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
    canRetry: boolean;
    offline: boolean;
  }>({
    key: '',
    page: null,
    items: [],
    source: null,
    loading: false,
    loadingMore: false,
    error: null,
    canRetry: true,
    offline: false,
  });
  const key = JSON.stringify([q, kind, standing, online, !!viewing]);

  const ask25 = React.useCallback(
    (cursor: string | null, signal?: AbortSignal) =>
      api
        .POST('/v1/queries/search.kind', {
          body: {
            workspaceId: business.id,
            q,
            kind,
            limit: KIND_PAGE,
            ...(cursor ? { cursor } : {}),
            ...(standing ? { standing } : {}),
          },
          signal,
        })
        .then((r) => unwrap(r) as SearchKindOutput),
    [business.id, q, kind, standing],
  );

  React.useEffect(() => {
    if (searchProbes(q).tooShort) {
      setState((s) => ({ ...s, key, page: null, items: [], loading: false, error: null }));
      return;
    }
    let live = true;
    const show = (s: Partial<typeof state>) => live && setState((was) => ({ ...was, key, ...s }));
    const fromCopy = () =>
      answerFromCopy(db, ask, { perKind: 100, settingsMatched: false })
        .then((a) => {
          const group = a.groups.find((g) => g.kind === kind) ?? null;
          show({
            page: group ? { group, nextCursor: null, standingCounts: null, duplicates: [] } : null,
            items: group?.items ?? [],
            source: 'phone',
            loading: false,
            error: null,
            offline: true,
          });
        })
        .catch(() => show({ loading: false, offline: true }));
    if (!online) {
      if (viewing) show({ page: null, items: [], loading: false, offline: true });
      else void fromCopy();
      return () => {
        live = false;
      };
    }
    const controller = new AbortController();
    show({ loading: true, error: null, offline: false });
    ask25(null, controller.signal)
      .then((page) =>
        show({
          page,
          items: page.group.items,
          source: 'server',
          loading: false,
          error: null,
        }),
      )
      .catch((e: unknown) => {
        if (!live || aborted(e)) return;
        if (noSignal(e)) {
          if (viewing) show({ page: null, items: [], loading: false, offline: true });
          else void fromCopy();
          return;
        }
        if (e instanceof ApiError && e.disposition === 'retry' && retried.current !== key) {
          retried.current = key;
          setTimeout(() => live && setRound((r) => r + 1), RETRY_MS);
          return;
        }
        show({ loading: false, error: errorMessage(e), canRetry: retryable(e) });
      });
    return () => {
      live = false;
      controller.abort();
    };
    // `key` holds everything else the search depends on.
  }, [key, ask, round]);

  const current = state.key === key;
  const page = current ? state.page : null;
  const showMore = React.useCallback(() => {
    const cursor = page?.nextCursor;
    if (!cursor || state.loadingMore) return;
    setState((s) => ({ ...s, loadingMore: true }));
    const more = (again: boolean): Promise<void> =>
      ask25(cursor)
        .then((next) =>
          setState((s) =>
            s.key !== key
              ? s
              : {
                  ...s,
                  page: { ...next, standingCounts: s.page?.standingCounts ?? next.standingCounts },
                  items: [...s.items, ...next.group.items],
                  loadingMore: false,
                },
          ),
        )
        .catch((e: unknown) => {
          if (again && e instanceof ApiError && e.disposition === 'retry') {
            setTimeout(() => void more(false), RETRY_MS);
            return;
          }
          setState((s) => ({
            ...s,
            loadingMore: false,
            error: errorMessage(e),
            canRetry: retryable(e),
          }));
        });
    void more(true);
  }, [page?.nextCursor, state.loadingMore, ask25, key]);

  return {
    q,
    group: page ? { ...page.group, items: current ? state.items : [] } : null,
    source: current ? state.source : null,
    standingCounts: page?.standingCounts ?? null,
    duplicates: page?.duplicates ?? [],
    more: !!page?.nextCursor,
    loading: current ? state.loading : !searchProbes(q).tooShort,
    loadingMore: current && state.loadingMore,
    error: current ? state.error : null,
    canRetry: current ? state.canRetry : true,
    offline: !online || (current && state.offline),
    viewingOffline: !!viewing && (!online || (current && state.offline)),
    showMore,
    retry: React.useCallback(() => setRound((r) => r + 1), []),
  };
}
