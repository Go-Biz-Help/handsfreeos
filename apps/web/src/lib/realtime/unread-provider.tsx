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
import { useLiveVersion } from './live-provider';

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
  const live = useLiveVersion(['conversation', 'message'], 400);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/inbox.summary', { body: { workspaceId } })
      .then((r) => {
        if (!cancelled) setSummary(unwrap(r));
      })
      .catch(() => {
        // Badges are a convenience; the inbox itself shows errors.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, live, nonce]);

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
