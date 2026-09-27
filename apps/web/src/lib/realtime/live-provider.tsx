'use client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import {
  createContext,
  startTransition,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isOwnRequest } from '@/lib/api/own-requests';
import { supabaseBrowser } from '@/lib/supabase/client';

/** What the database broadcasts for every event in the workspace: ids only, never row data. */
export interface LiveChange {
  readonly id: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly at: string;
}

type Listener = (change: LiveChange | { entityType: '*'; type: 'resync' }) => void;

interface LiveContextValue {
  /** `whileHidden` listeners still hear changes in a background tab (the unread count in the tab title). */
  subscribe(listener: Listener, whileHidden?: boolean): () => void;
  connected: boolean;
}

const LiveContext = createContext<LiveContextValue>({
  subscribe: () => () => {},
  connected: false,
});

const POLL_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * One private Realtime channel per workspace. Screens subscribe through useLiveRefresh (server-rendered
 * pages) or useLiveVersion (client-fetched components). This tab's own edits are dropped by correlation id;
 * a reconnect re-syncs because Realtime does not replay what happened while the channel was down.
 */
export function LiveProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const listeners = useRef(new Map<Listener, boolean>());
  const [connected, setConnected] = useState(false);
  const value = useRef<LiveContextValue>({
    subscribe(listener, whileHidden = false) {
      listeners.current.set(listener, whileHidden);
      return () => listeners.current.delete(listener);
    },
    connected: false,
  });
  value.current = { ...value.current, connected };

  useEffect(() => {
    const supabase = supabaseBrowser();
    let channel: RealtimeChannel | null = null;
    let stopped = false;
    let attempt = 0;
    let hadSession = false;
    let backoff: ReturnType<typeof setTimeout> | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    // A hidden tab refetches nothing; it catches up with one resync when it is shown again.
    let missed = false;

    const notify: Listener = (change) => {
      const hidden = document.visibilityState !== 'visible';
      if (hidden) missed = true;
      for (const [l, whileHidden] of listeners.current) if (!hidden || whileHidden) l(change);
    };
    const resync = () => notify({ entityType: '*', type: 'resync' });
    const startPolling = () => {
      if (!poll) poll = setInterval(resync, POLL_MS);
    };
    const stopPolling = () => {
      if (poll) clearInterval(poll);
      poll = null;
    };
    const teardown = () => {
      // Cleared first: removing the channel echoes CLOSED to its callback, which must see it is no longer current.
      const old = channel;
      channel = null;
      if (old) void supabase.removeChannel(old);
    };
    const scheduleReconnect = () => {
      if (stopped || backoff) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt++);
      backoff = setTimeout(() => {
        backoff = null;
        teardown();
        void connect();
      }, delay);
    };

    async function connect() {
      if (stopped) return;
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        startPolling();
        scheduleReconnect();
        return;
      }
      await supabase.realtime.setAuth(token);
      const mine = supabase.channel(`workspace:${workspaceId}`, { config: { private: true } });
      channel = mine;
      mine.on('broadcast', { event: 'change' }, (msg) => {
        const payload = msg.payload as LiveChange;
        // Echoes of this tab's own edits are dropped. The worker's follow-ups (system events, no actor) share
        // the request's correlation id but are news here, so they always come through.
        if (payload.actorId && isOwnRequest(payload.correlationId)) return;
        notify(payload);
      });
      mine.subscribe((status) => {
        // A replaced channel's late CLOSED would otherwise tear down the healthy one, looping reconnects.
        if (stopped || channel !== mine) return;
        if (status === 'SUBSCRIBED') {
          attempt = 0;
          stopPolling();
          setConnected(true);
          // Anything that happened before the join (or while reconnecting) was not delivered.
          if (hadSession) resync();
          hadSession = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setConnected(false);
          startPolling();
          scheduleReconnect();
        }
      });
    }

    const { data: auth } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session)
        void supabase.realtime.setAuth(session.access_token);
      if (event === 'SIGNED_OUT') teardown();
    });
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (missed) {
        missed = false;
        resync();
      }
      if (!channel) scheduleReconnect();
    };
    document.addEventListener('visibilitychange', onVisible);
    void connect();

    return () => {
      stopped = true;
      auth.subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      if (backoff) clearTimeout(backoff);
      stopPolling();
      teardown();
    };
  }, [workspaceId]);

  return <LiveContext.Provider value={value.current}>{children}</LiveContext.Provider>;
}

function matches(change: Parameters<Listener>[0], entityTypes?: readonly string[]): boolean {
  if (change.entityType === '*') return true;
  return !entityTypes || entityTypes.includes(change.entityType);
}

/**
 * Refreshes the server-rendered page (debounced) when a teammate changes one of these entity types. Paused while
 * the tab is hidden; it refreshes once when shown again.
 */
export function useLiveRefresh(entityTypes?: readonly string[], debounceMs = 300): void {
  const { subscribe } = useContext(LiveContext);
  const router = useRouter();
  // undefined is every change; [] is none (''), which must not fall through to "every".
  const key = entityTypes === undefined ? undefined : entityTypes.join(',');
  useEffect(() => {
    if (key === '') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const types = key === undefined ? undefined : key.split(',');
    return subscribe((change) => {
      if (!matches(change, types)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => startTransition(() => router.refresh()), debounceMs);
    });
  }, [subscribe, router, key, debounceMs]);
}

/**
 * A counter that bumps (debounced) on matching changes, for components that fetch their own data. Paused while
 * the tab is hidden (one resync on return) unless `whileHidden`.
 */
export function useLiveVersion(
  entityTypes?: readonly string[],
  debounceMs = 300,
  whileHidden = false,
): number {
  const { subscribe } = useContext(LiveContext);
  const [version, setVersion] = useState(0);
  // undefined is every change; [] is none (''), which must not fall through to "every".
  const key = entityTypes === undefined ? undefined : entityTypes.join(',');
  useEffect(() => {
    if (key === '') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const types = key === undefined ? undefined : key.split(',');
    return subscribe((change) => {
      if (!matches(change, types)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setVersion((v) => v + 1), debounceMs);
    }, whileHidden);
  }, [subscribe, key, debounceMs, whileHidden]);
  return version;
}

export function useLiveConnected(): boolean {
  return useContext(LiveContext).connected;
}
