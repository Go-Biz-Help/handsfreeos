import type { paths } from '@hfos/api-client';
import { BALANCE_WORDS } from '@hfos/core';
import * as React from 'react';

import { api, errorMessage, unwrap } from '@/lib/api';
import { useNetwork } from '@/lib/network';

/**
 * The business's own balance on the phone — what `wallet.get`, `usage.prices` and `usage.statement` answer, and the
 * four things a person may do to it.
 *
 * **None of this is in the phone's copy, and it shouldn't be.** A balance sitting in SQLite from yesterday morning
 * is a number somebody would act on: top up when they already have, or not top up when they're about to be cut off.
 * So the screen is live or it says it needs a signal — the same rule the Assistant's chats follow.
 */

type Ok<P extends keyof paths> = paths[P] extends {
  post: { responses: { 200: { content: { 'application/json': infer R } } } };
}
  ? R
  : never;

export type Wallet = Ok<'/v1/queries/wallet.get'>;
export type Prices = Ok<'/v1/queries/usage.prices'>;
export type Statement = Ok<'/v1/queries/usage.statement'>;
export type StatementEntry = Statement['items'][number];

/** How many rows of the statement come down at a time. The web asks for 50 on a page with room for them. */
const PAGE = 25;

export interface WalletView {
  readonly wallet: Wallet | null;
  readonly prices: Prices | null;
  readonly entries: readonly StatementEntry[];
  /** More statement to ask for, and whether a page is on its way. */
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loading: boolean;
  /** Words for what went wrong, or that it needs a signal. Null while it's fine. */
  readonly error: string | null;
  reload(): void;
  more(): void;
}

export function useWallet(workspaceId: string): WalletView {
  const { online } = useNetwork();
  const [state, setState] = React.useState<{
    wallet: Wallet | null;
    prices: Prices | null;
    entries: readonly StatementEntry[];
    cursor: string | null;
  }>({ wallet: null, prices: null, entries: [], cursor: null });
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [round, setRound] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const body = { body: { workspaceId } };
    Promise.all([
      api.POST('/v1/queries/wallet.get', body).then(unwrap),
      api.POST('/v1/queries/usage.prices', body).then(unwrap),
      api.POST('/v1/queries/usage.statement', { body: { workspaceId, limit: PAGE } }).then(unwrap),
    ])
      .then(([wallet, prices, statement]) => {
        if (cancelled) return;
        setState({
          wallet,
          prices,
          entries: statement.items,
          cursor: statement.nextCursor,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(online ? errorMessage(e) : BALANCE_WORDS.needsSignal);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `online` is in here so coming back into signal on this screen fetches it, rather than leaving the
    // "needs a signal" card sitting there until somebody presses Try again.
  }, [online, round, workspaceId]);

  const more = React.useCallback(() => {
    const cursor = state.cursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    api
      .POST('/v1/queries/usage.statement', { body: { workspaceId, limit: PAGE, cursor } })
      .then(unwrap)
      .then((page) =>
        setState((was) =>
          // The reload that happened while this page was in the air wins: its cursor is no longer this one.
          was.cursor === cursor
            ? { ...was, entries: [...was.entries, ...page.items], cursor: page.nextCursor }
            : was,
        ),
      )
      .catch((e: unknown) => setError(online ? errorMessage(e) : BALANCE_WORDS.needsSignal))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, online, state.cursor, workspaceId]);

  return {
    wallet: state.wallet,
    prices: state.prices,
    entries: state.entries,
    hasMore: state.cursor !== null,
    loadingMore,
    loading: loading && state.wallet === null,
    error,
    reload: () => setRound((r) => r + 1),
    more,
  };
}

/**
 * The three commands the screen sends. They go straight out rather than into the queue of changes: money moving on a
 * card, and the card itself, are not things to do silently three hours later when a signal turns up.
 */
export const walletCommands = {
  async setAutoTopup(
    workspaceId: string,
    patch: { autoTopup?: boolean; floorCents?: number; topupCents?: number },
  ): Promise<void> {
    unwrap(
      await api.POST('/v1/commands/wallet.set_auto_topup', { body: { workspaceId, ...patch } }),
    );
  },
  async topUp(workspaceId: string): Promise<void> {
    unwrap(await api.POST('/v1/commands/wallet.top_up', { body: { workspaceId } }));
  },
  async forgetCard(workspaceId: string): Promise<void> {
    unwrap(await api.POST('/v1/commands/wallet.forget_card', { body: { workspaceId } }));
  },
};
