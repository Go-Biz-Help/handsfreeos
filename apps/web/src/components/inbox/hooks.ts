'use client';
import { CONVERSATION_DONE, type InboxBoxKey, type InboxMailbox, type NoteEntry } from '@hfos/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type {
  ConversationStatus,
  ConversationSummary,
  ConversationThread,
  ThreadItem,
} from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';
import { useUnread } from '@/lib/realtime/unread-provider';

export interface InboxFilters {
  /** Mine, unassigned or everyone's, or the AI teammate's boxes: "Needs a person" and its own. */
  readonly box: InboxBoxKey;
  /** The team's threads (the default), or the person's own mail (M19). */
  readonly mailbox?: InboxMailbox;
  readonly status: ConversationStatus;
  readonly channel?: 'sms' | 'email' | 'chat';
  readonly q?: string;
  /** Only customers with something unread. */
  readonly unread?: boolean;
}

const PAGE = 30;

/**
 * The conversation list. The first page loads on every filter change; teammates' and customers' changes
 * refetch as many rows as are showing (so "Show more" pages survive a live refresh).
 */
export function useInboxList(workspaceId: string, filters: InboxFilters) {
  // Drafts: a row says when the teammate's reply waits for an OK.
  const live = useLiveVersion(
    ['conversation', 'message', 'call', 'person', 'ai_teammate_draft'],
    300,
  );
  const mailbox = filters.mailbox ?? 'team';
  const key = `${mailbox}|${filters.box}|${filters.status}|${filters.channel ?? ''}|${filters.q ?? ''}|${filters.unread ? 'unread' : ''}`;
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
      ...(mailbox === 'mine' ? { mailbox } : {}),
      status: filters.status,
      ...(filters.channel ? { channel: filters.channel } : {}),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.unread ? { unread: true } : {}),
    }),
    [workspaceId, filters.box, mailbox, filters.status, filters.channel, filters.q, filters.unread],
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
  /** "All lines": refreshes and earlier pages have to ask for the same woven thread (0089). */
  allLanes = false,
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
        body: { workspaceId, conversationId, limit: PAGE, ...(allLanes ? { allLanes } : {}) },
      })
      .then((r) => {
        if (cancelled) return;
        const fresh = unwrap(r).items;
        setItems((old) => {
          const freshIds = new Set(fresh.map((i) => i.id));
          // A text held for quiet hours sits at the newest end of the thread; gone from the newest page, it was
          // cancelled (a sent one comes back under the same id).
          const map = new Map(
            old.filter((i) => !i.scheduledFor || freshIds.has(i.id)).map((i) => [i.id, i]),
          );
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
  }, [workspaceId, conversationId, live, nonce, allLanes]);

  const loadEarlier = useCallback(async () => {
    if (!cursor) return;
    setLoadingEarlier(true);
    try {
      const out = unwrap(
        await apiBrowser().POST('/v1/queries/conversation.thread', {
          body: {
            workspaceId,
            conversationId,
            cursor,
            limit: PAGE,
            ...(allLanes ? { allLanes } : {}),
          },
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
  }, [workspaceId, conversationId, cursor, allLanes]);

  /**
   * Refreshes, then pages back until `id` is in the thread again. A held retry, cancelled, goes back to the time
   * its failed attempt had, which may be older than the newest page; the pages in between come too, so "Show
   * earlier" still carries on from the oldest one shown.
   */
  const bringBack = useCallback(
    async (id: string) => {
      const got: ThreadItem[] = [];
      let next: string | null = null;
      try {
        for (let page = 0; page < 20; page++) {
          const out: ConversationThread = unwrap(
            await apiBrowser().POST('/v1/queries/conversation.thread', {
              body: {
                workspaceId,
                conversationId,
                limit: PAGE,
                ...(next ? { cursor: next } : {}),
                ...(allLanes ? { allLanes } : {}),
              },
            }),
          );
          got.push(...out.items);
          next = out.nextCursor;
          if (!next || out.items.some((i) => i.id === id)) break;
        }
      } catch {
        // The next live change or a reload tries again.
        setNonce((n) => n + 1);
        return;
      }
      const oldest = got.reduce<string | null>(
        (min, i) => (min === null || i.occurredAt < min ? i.occurredAt : min),
        null,
      );
      setItems((old) => {
        const map = new Map(old.map((i) => [i.id, i]));
        for (const i of got) map.set(i.id, i);
        return [...map.values()].sort(byTime);
      });
      // Reached further back than the thread had: "Show earlier" carries on from there.
      const shownFrom = items[0]?.occurredAt ?? null;
      if (oldest && (shownFrom === null || oldest < shownFrom)) setCursor(next);
    },
    [workspaceId, conversationId, allLanes, items],
  );

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
    bringBack,
    /** Takes an item out of the thread at once (a held text just cancelled). */
    forget: useCallback((id: string) => setItems((all) => all.filter((i) => i.id !== id)), []),
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
 * The notes the business wrote about this customer, for the thread (M10 step 15). The phone has shown them in the
 * thread since step 14; Chris decided on 2026-09-17 to keep them there and let the web catch up. They come from the
 * customer's own timeline, so a note added anywhere shows in every conversation of theirs.
 */
export function useCustomerNotes(workspaceId: string, personId: string | null): NoteEntry[] {
  const [notes, setNotes] = useState<NoteEntry[]>([]);
  const live = useLiveVersion(['activity'], 200);
  useEffect(() => {
    if (!personId) {
      setNotes([]);
      return;
    }
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/timeline.list', {
        body: { workspaceId, recordType: 'person', recordId: personId, limit: 50 },
      })
      .then((r) => {
        if (cancelled) return;
        const items = unwrap(r).items.filter((e) => e.kind === 'note');
        setNotes(
          items.map((e) => ({
            id: e.id,
            body: e.body ?? '',
            occurredAt: e.occurredAt,
            author: e.actor?.fullName ?? null,
            waiting: false,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setNotes([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, personId, live]);
  return notes;
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
        CONVERSATION_DONE.markedUnread,
      ),
    /**
     * Close every line this customer writes on (0089).
     *
     * Its own call rather than a loop over the lanes here, so the whole thing is one command in the audit and
     * one transaction: closing three of four and failing on the last would leave the inbox in a state nobody
     * asked for, and the phone replaying a queued close must never find it grew into a close-everything.
     */
    closeAll: async (): Promise<boolean> => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/conversation.close_all', { body: ref }),
        );
        toast.success(CONVERSATION_DONE.closedAll(out.closed));
        refreshUnread();
        after();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    /** An email thread to the Inbox, Other mail or Spam (M19); with remember, the sender's next thread too. */
    move: async (folder: 'inbox' | 'other' | 'spam', remember = false): Promise<boolean> => {
      try {
        const out = unwrap(
          await apiBrowser().POST('/v1/commands/conversation.move', {
            body: { ...ref, folder, remember },
          }),
        );
        toast.success(
          out.changed || remember
            ? CONVERSATION_DONE.moved(folder, remember)
            : CONVERSATION_DONE.alreadyThere,
        );
        refreshUnread();
        after();
        return true;
      } catch (e) {
        toast.error(errorMessage(e));
        return false;
      }
    },
    /** Out of the person's own mail and into the team's Inbox (M19). */
    share: () =>
      attempt(
        async () =>
          unwrap(await apiBrowser().POST('/v1/commands/conversation.share', { body: ref })),
        CONVERSATION_DONE.shared,
      ),
    archive: () =>
      attempt(
        async () =>
          unwrap(await apiBrowser().POST('/v1/commands/conversation.archive', { body: ref })),
        CONVERSATION_DONE.archived,
      ),
    restore: () =>
      attempt(
        async () =>
          unwrap(await apiBrowser().POST('/v1/commands/conversation.restore', { body: ref })),
        CONVERSATION_DONE.restored,
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
        CONVERSATION_DONE.reopened,
      ),
  };
}
