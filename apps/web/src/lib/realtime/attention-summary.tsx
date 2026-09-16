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
import type { AttentionSummary } from '@/lib/api/types';
import { useLiveVersion } from './live-provider';

interface AttentionSummaryValue {
  readonly summary: AttentionSummary | null;
  /** Read again now (after this tab's own changes, which don't come back over Realtime). */
  readonly refresh: () => void;
}

const AttentionSummaryContext = createContext<AttentionSummaryValue>({
  summary: null,
  refresh: () => {},
});

/** Items turn urgent as time passes, with no event: the count is read again this often while the tab is in view. */
const EVERY_MS = 60_000;

/**
 * The Action Center's counts behind the urgent badge on Home (M8): read on mount, when an item changes, every minute
 * while the tab is in view, when the tab comes back, and on demand.
 */
export function AttentionSummaryProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const [summary, setSummary] = useState<AttentionSummary | null>(null);
  const [nonce, setNonce] = useState(0);
  const live = useLiveVersion(['attention_item'], 500);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/attention.summary', { body: { workspaceId } })
      .then((r) => {
        if (!cancelled) setSummary(unwrap(r));
      })
      .catch(() => {
        // The badge is a nicety; Home itself says what needs attention.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, live, nonce]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const value = useMemo(() => ({ summary, refresh }), [summary, refresh]);
  return (
    <AttentionSummaryContext.Provider value={value}>{children}</AttentionSummaryContext.Provider>
  );
}

export function useAttentionSummary(): AttentionSummaryValue {
  return useContext(AttentionSummaryContext);
}
