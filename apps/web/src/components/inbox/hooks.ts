'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  ConversationStatus,
  ConversationSummary,
  ConversationThread,
  InboxBox,
  ThreadItem,
} from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { useUnread } from '@/lib/realtime/unread-provider';

export interface InboxFilters {
  readonly box: InboxBox;
  readonly status: ConversationStatus;
  readonly channel?: 'sms' | 'email';
  readonly q?: string;
}

const PAGE = 30;

/**
 * The conversation list. The first page loads on every filter change; teammates' and customers' changes
 * refetch as many rows as are showing (so "Show more" pages survive a live refresh).
 */
export function useInboxList(workspaceId: string, filters: InboxFilters) {
  const live = useLiveVersion(['conversation', 'message', 'call', 'person'], 300);
  const key = `${filters.box}|${filters.status}|${filters.channel ?? ''}|${filters.q ?? ''}`;
  const [state, setState] = useState<{
    key: string;
    items: ConversationSummary[];
    cursor: string | null;
    loaded: boolean;
    error: string | null;
  }>({ key, items: [], cursor: null, loaded: false, error: null });
  const [nonce, setNonce] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const showing = useRef(PAGE);

  const body = useMemo(
    () => ({
      workspaceId,
      box: filters.box,
      status: filters.status,
      ...(filters.channel ? { channel: filters.channel } : {}),
      ...(filters.q ? { q: filters.q } : {}),
    }),
    [workspaceId, filters.box, filters.status, filters.channel, filters.q],
  );

  useEffect(() => {
    let cancelled = false;
    const limit = Math.min(100, Math.max(PAGE, showing.current));
    apiBrowser()
      .POST('/v1/queries/inbox.list', { body: { ...body, limit } })
      .then((r) => {
        if (cancelled) return;
        const out = unwrap(r);
        setState({ key, items: out.items, cursor: out.nextCursor, loaded: true, error: null });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState((s) => ({ ...s, key, loaded: true, error: errorMessage(e) }));
      });
    return () => {
      cancelled = true;
    };
  }, [body, key, live, nonce]);

  // A new filter starts from one page again.
  useEffect(() => {
    showing.current = PAGE;
  }, [key]);

  const loadMore = useCallback(async () => {
    if (!state.cursor || state.key !== key) return;
    setLoadingMore(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/inbox.list', {
          body: { ...body, cursor: state.cursor, limit: PAGE },
        }),
      );
      setState((s) => {
        if (s.key !== key) return s;
        const seen = new Set(s.items.map((i) => i.id));
        const items = [...s.items, ...out.items.filter((i) => !seen.has(i.id))];
        showing.current = items.length;
        return { ...s, items, cursor: out.nextCursor };
      });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  }, [body, key, state.cursor, state.key]);

  /** Local change before the server confirms (opening a conversation clears its unread count). */
  const patch = useCallback((id: string, change: Partial<ConversationSummary>) => {
    setState((s) => ({
      ...s,
      items: s.items.map((i) => (i.id === id ? { ...i, ...change } : i)),
    }));
  }, []);

  const current = state.key === key;
  return {
    items: current ? state.items : [],
    hasMore: current && !!state.cursor,
    loading: !current || !state.loaded,
    error: current ? state.error : null,
    loadingMore,
    loadMore,
    reload: useCallback(() => setNonce((n) => n + 1), []),
    patch,
  };
}

/** A text on its way: shown at once, replaced by the stored message when it arrives. */
export interface PendingText {
  readonly clientId: string;
  readonly body: string;
  readonly at: string;
  /** Email shows as a mail card while it sends. */
  readonly channel?: 'sms' | 'email';
  readonly subject?: string;
  readonly from?: string;
  readonly messageId: string | null;
  readonly error: string | null;
}

const byTime = (a: ThreadItem, b: ThreadItem) =>
  a.occurredAt === b.occurredAt ? a.id.localeCompare(b.id) : a.occurredAt < b.occurredAt ? -1 : 1;

/**
 * One conversation's thread, oldest first. Live changes refetch the newest page and merge it by id, so a
 * delivery receipt updates the bubble it belongs to; "Show earlier" pages back with the keyset cursor.
 */
export function useThread(
  workspaceId: string,
  conversationId: string,
  initial: ConversationThread,
) {
  const [items, setItems] = useState<ThreadItem[]>(() => [...initial.items].sort(byTime));
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [pending, setPending] = useState<PendingText[]>([]);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [nonce, setNonce] = useState(0);
  const live = useLiveVersion(['message', 'conversation', 'call'], 200);
  const first = useRef(true);

  // The server page re-renders with a new conversation: start over from its first page.
  const [shownFor, setShownFor] = useState(conversationId);
  if (shownFor !== conversationId) {
    setShownFor(conversationId);
    setItems([...initial.items].sort(byTime));
    setCursor(initial.nextCursor);
    setPending([]);
  }

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/conversation.thread', {
        body: { workspaceId, conversationId, limit: PAGE },
      })
      .then((r) => {
        if (cancelled) return;
        const fresh = unwrap(r).items;
        setItems((old) => {
          const map = new Map(old.map((i) => [i.id, i]));
          for (const i of fresh) map.set(i.id, i);
          return [...map.values()].sort(byTime);
        });
      })
      .catch(() => {
        // The next live change or a reload tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, conversationId, live, nonce]);

  const loadEarlier = useCallback(async () => {
    if (!cursor) return;
    setLoadingEarlier(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/conversation.thread', {
          body: { workspaceId, conversationId, cursor, limit: PAGE },
        }),
      );
      setItems((old) => {
        const map = new Map(old.map((i) => [i.id, i]));
        for (const i of out.items) map.set(i.id, i);
        return [...map.values()].sort(byTime);
      });
      setCursor(out.nextCursor);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingEarlier(false);
    }
  }, [workspaceId, conversationId, cursor]);

  const ids = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  // Pending texts drop out once the stored message is in the thread.
  const waiting = pending.filter((p) => !p.messageId || !ids.has(p.messageId));

  return {
    items,
    pending: waiting,
    hasEarlier: !!cursor,
    loadingEarlier,
    loadEarlier,
    refresh: useCallback(() => setNonce((n) => n + 1), []),
    addPending: useCallback(
      (p: Omit<PendingText, 'messageId' | 'error'>) =>
        setPending((all) => [...all, { ...p, messageId: null, error: null }]),
      [],
    ),
    settlePending: useCallback(
      (clientId: string, result: { messageId?: string; error?: string }) =>
        setPending((all) =>
          all.map((p) =>
            p.clientId === clientId
              ? { ...p, messageId: result.messageId ?? null, error: result.error ?? null }
              : p,
          ),
        ),
      [],
    ),
    dropPending: useCallback(
      (clientId: string) => setPending((all) => all.filter((p) => p.clientId !== clientId)),
      [],
    ),
  };
}

/**
 * Conversation actions. Each takes the confirmation the design words for it; `after` refreshes whatever is
 * showing. They resolve to whether the change went through.
 */
export function useConversationActions(
  workspaceId: string,
  conversationId: string,
  after: () => void,
) {
  const { refresh: refreshUnread } = useUnread();
  const ref = { workspaceId, conversationId };
  const attempt = async (call: () => Promise<unknown>, success: string): Promise<boolean> => {
    try {
      await call();
      toast.success(success);
      refreshUnread();
      after();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    }
  };
  return {
    async markRead() {
      try {
        unwrap(await apiBrowser().POST('/v1/commands/conversation.mark_read', { body: ref }));
        refreshUnread();
        after();
      } catch {
        // Reading is best effort; the badge catches up on the next change.
      }
    },
    markUnread: () =>
      attempt(
        async () =>
          unwrap(await apiBrowser().POST('/v1/commands/conversation.mark_unread', { body: ref })),
        'Marked as unread',
      ),
    assign: (assigneeUserId: string | null, success: string) =>
      attempt(
        async () =>
          unwrap(
            await apiBrowser().POST('/v1/commands/conversation.assign', {
              body: { ...ref, assigneeUserId },
            }),
          ),
        success,
      ),
    snooze: (until: Date, success: string) =>
      attempt(
        async () =>
          unwrap(
            await apiBrowser().POST('/v1/commands/conversation.snooze', {
              body: { ...ref, until: until.toISOString() },
            }),
          ),
        success,
      ),
    close: (success: string) =>
      attempt(
        async () =>
          unwrap(await apiBrowser().POST('/v1/commands/conversation.close', { body: ref })),
        success,
      ),
    reopen: () =>
      attempt(
        async () =>
          unwrap(await apiBrowser().POST('/v1/commands/conversation.reopen', { body: ref })),
        'Back in the inbox',
      ),
  };
}
