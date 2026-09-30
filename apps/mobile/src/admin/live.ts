import type { paths } from '@hfos/api-client';
import * as React from 'react';

import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

import { DESK_PHONE_WORDS } from './words';

/**
 * The support desk on the phone asks HandsFreeOS for everything, every time.
 *
 * **None of it is in the phone's copy.** Tickets, the businesses and the health of the platform belong to HandsFreeOS
 * rather than to a business, so the sync service never carries them, and a queue from an hour ago would send two
 * people to answer the same ticket. Every screen here is live or says it needs a signal, as Ideas is, and nothing goes
 * into the queue of changes: a reply goes straight out, and says so when it can't.
 */

/** What a query or command answers, from the API's own description of it. */
export type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

/** What a query or command takes. */
export type In<P extends keyof paths> = paths[P] extends {
  post: { requestBody?: { content: { 'application/json': infer B } } };
}
  ? B
  : never;

export interface Live<T> {
  readonly data: T | null;
  /** Nothing to show yet, and an answer on its way. */
  readonly loading: boolean;
  /** Something to show, and a fresher answer on its way (pulled down to refresh). */
  readonly refreshing: boolean;
  /** Words for what went wrong, or that it needs a signal. Null while it's fine. */
  readonly error: string | null;
  reload(): void;
  /** Puts a changed copy in place without asking again. */
  update(change: (was: T) => T): void;
}

/**
 * One answer from HandsFreeOS, asked again when `key` changes, when somebody presses Try again, and when the phone
 * comes back into signal on the screen, so the "needs a signal" card doesn't sit there once it has one.
 */
export function useLive<T>(load: () => Promise<T>, key: string): Live<T> {
  const { online } = useNetwork();
  const [data, setData] = React.useState<{ key: string; value: T } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);
  const latest = React.useRef(load);
  latest.current = load;

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    latest
      .current()
      .then((value) => {
        if (!cancelled) setData({ key, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(online ? errorMessage(e) : DESK_PHONE_WORDS.needsSignal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, online, round]);

  // An answer for another filter is not an answer for this one: the list waits for its own.
  const value = data && data.key === key ? data.value : null;
  return {
    data: value,
    loading: loading && value === null,
    refreshing: loading && value !== null,
    error,
    reload: React.useCallback(() => setRound((r) => r + 1), []),
    update: React.useCallback(
      (change: (was: T) => T) =>
        setData((was) => (was ? { key: was.key, value: change(was.value) } : was)),
      [],
    ),
  };
}

/** A list that comes a page at a time, as the queue and the businesses do. */
export interface Paged<T extends { readonly nextCursor: string | null }> extends Live<T> {
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  more(): void;
}

/**
 * `useLive` for a list with a cursor: `load` asks for the first page (no cursor) or the next one, and `join` puts a
 * next page after the ones already there.
 */
export function usePaged<T extends { readonly nextCursor: string | null }>(
  load: (cursor: string | null) => Promise<T>,
  join: (was: T, page: T) => T,
  key: string,
): Paged<T> {
  const live = useLive(() => load(null), key);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const cursor = live.data?.nextCursor ?? null;
  const { update } = live;
  const latest = React.useRef({ load, join });
  latest.current = { load, join };

  const more = React.useCallback(() => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    latest.current
      .load(cursor)
      .then((page) =>
        // A reload that landed while this page was in the air wins: its cursor is no longer this one.
        update((was) => (was.nextCursor === cursor ? latest.current.join(was, page) : was)),
      )
      .catch(() => undefined)
      .finally(() => setLoadingMore(false));
  }, [cursor, loadingMore, update]);

  return { ...live, hasMore: cursor !== null, loadingMore, more };
}

/**
 * Asks a query or sends a command, and answers with its data or throws the API's own words. The generated client's
 * types go several thousand paths deep; one loose door here keeps the compiler sane, as the web's desk does.
 */
export async function desk<P extends keyof paths>(path: P, body: In<P>): Promise<Ok<P>> {
  const post = api.POST as unknown as (
    p: string,
    o: { body: unknown },
  ) => Promise<{ data?: Ok<P>; error?: unknown; response: Response }>;
  return unwrap(await post(path, { body }));
}
