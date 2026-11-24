'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { InboxSummary } from '@/lib/api/types';
import { useInTurn } from './in-turn';
import { DELIVERY_RECEIPTS, useLiveVersion } from './live-provider';

interface UnreadValue {
  readonly summary: InboxSummary | null;
  /** Refetch now (after this browser marks something read; own changes do not come back over Realtime). */
  readonly refresh: () => void;
}

const UnreadContext = createContext<UnreadValue>({ summary: null, refresh: () => {} });

const TITLE_COUNT = /^\(\d+\)\s+/;

/**
 * The inbox counts behind the unread badges. Fetched on mount, when a teammate or a customer changes a
 * conversation, when the tab becomes visible again, and on demand; the browser tab title carries the count.
 */
export function UnreadProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [nonce, setNonce] = useState(0);
  // Kept live in a background tab: the count in its title is how a hidden tab says something came in. Every open
  // tab asks, so a run of delivery receipts (no count is made of one) asks once, and one request at a time.
  const live = useLiveVersion(['conversation', 'message'], 400, {
    whileHidden: true,
    seldom: DELIVERY_RECEIPTS,
  });
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const inTurn = useInTurn();
  useEffect(() => {
    let replaced = false;
    inTurn(workspaceId, async () => {
      // Replaced while it waited its turn: the one behind it asks for what both wanted.
      if (replaced) return;
      try {
        const got = unwrap(
          await apiBrowser().POST('/v1/queries/inbox.summary', { body: { workspaceId } }),
        );
        if (!replaced) setSummary(got);
      } catch {
        // Badges are a convenience; the inbox itself shows errors.
      }
    });
    return () => {
      replaced = true;
    };
  }, [workspaceId, live, nonce, inTurn]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const unread = summary?.unread.all ?? 0;
  useEffect(() => {
    const apply = () => {
      const base = document.title.replace(TITLE_COUNT, '');
      const next = unread > 0 ? `(${unread}) ${base}` : base;
      if (document.title !== next) document.title = next;
    };
    apply();
    // Next.js rewrites the title on navigation; keep the count in front of whatever it sets.
    const observer = new MutationObserver(apply);
    const title = document.querySelector('title');
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      document.title = document.title.replace(TITLE_COUNT, '');
    };
  }, [unread]);

  const value = useMemo(() => ({ summary, refresh }), [summary, refresh]);
  return <UnreadContext.Provider value={value}>{children}</UnreadContext.Provider>;
}

export function useUnread(): UnreadValue {
  return useContext(UnreadContext);
}
