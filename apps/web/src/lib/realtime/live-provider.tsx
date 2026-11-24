'use client';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { isOwnRequest } from '@/lib/api/own-requests';
import { supabaseBrowser } from '@/lib/supabase/client';
import { browserAccessToken } from '@/lib/supabase/token';
import { redrawLine, type RedrawLine, type Redraws } from './redraws';

/**
 * What the database broadcasts for every event in the workspace: ids only, never row data. For the inbox's and
 * money's events not even the entity's or the person's id (20261012020500): everyone in the workspace hears them.
 */
export interface LiveChange {
  readonly id: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** Who acted, by kind ('human', 'system', ...); absent from broadcasts sent before it was added. */
  readonly actorType?: string;
  readonly actorId: string | null;
  readonly correlationId: string | null;
  readonly at: string;
}

type Listener = (change: LiveChange | { entityType: '*'; type: 'resync' }) => void;

interface LiveContextValue {
  /** `whileHidden` listeners still hear changes in a background tab (the unread count in the tab title). */
  subscribe(listener: Listener, whileHidden?: boolean): () => void;
  /** Where a screen asks for the page to be drawn again: one at a time for them all (./redraws.ts). */
  redraws: Redraws;
  connected: boolean;
}

const LiveContext = createContext<LiveContextValue>({
  subscribe: () => () => {},
  redraws: { ask: () => {}, forget: () => {} },
  connected: false,
});

const POLL_MS = 60_000;
/** A change this tab makes up and tells only itself about (the demo player's scenes, lib/demo). */
const LOCAL_CHANGE_EVENT = 'hfos:local-change';
const MAX_BACKOFF_MS = 30_000;
const MAX_WAIT_MS = 5_000;

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
  const [line] = useState(redrawLine);
  const value = useRef<LiveContextValue>({
    subscribe(listener, whileHidden = false) {
      listeners.current.set(listener, whileHidden);
      return () => listeners.current.delete(listener);
    },
    redraws: line,
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
      const token = await browserAccessToken();
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
        // the request's correlation id but are news here, so they always come through. A person's event on the
        // inbox or money arrives without their id, so its kind says it was a person's (or their Assistant's).
        if (
          (payload.actorId || payload.actorType === 'human' || payload.actorType === 'assistant') &&
          isOwnRequest(payload.correlationId)
        )
          return;
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
    const onLocal = (e: Event) => notify((e as CustomEvent<LiveChange>).detail);
    window.addEventListener(LOCAL_CHANGE_EVENT, onLocal);
    void connect();

    return () => {
      stopped = true;
      auth.subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(LOCAL_CHANGE_EVENT, onLocal);
      if (backoff) clearTimeout(backoff);
      stopPolling();
      teardown();
    };
  }, [workspaceId]);

  return (
    <LiveContext.Provider value={value.current}>
      <LiveRedraws line={line} />
      {children}
    </LiveContext.Provider>
  );
}

/**
 * Draws the page again for the screens that asked (./redraws.ts), and says when it is there. On its own, so that a
 * page being drawn changes nothing the screens are given.
 */
function LiveRedraws({ line }: { line: RedrawLine }) {
  const router = useRouter();
  const [drawing, draw] = useTransition();
  useEffect(() => {
    line.drawWith(() => draw(() => router.refresh()));
    return () => line.drawWith(null);
  }, [line, router]);
  useEffect(() => {
    if (!drawing) line.landed();
  }, [line, drawing]);
  return null;
}

/**
 * Options for the live hooks. `only` narrows some entity types to the ids on screen (the open conversation, the
 * lead in the drawer), so a change to another record of that type does not refetch this one.
 */
export interface LiveOptions {
  readonly only?: Readonly<Record<string, readonly string[]>>;
  /** Keep listening in a background tab (the unread count in the tab title). */
  readonly whileHidden?: boolean;
  /**
   * useLiveVersion only: kinds of event that seldom change what this screen shows (DELIVERY_RECEIPTS, for a list of
   * conversations and its counts). They are still heard, so nothing that leans on one is lost, but a run of them
   * asks once every few seconds, not once each.
   */
  readonly seldom?: readonly string[];
}

/**
 * What a carrier, a mail service or the customer's own app says became of a message that went out
 * (`message.update_status` in core, and its like for chat, the portal and social). It changes that message's bubble
 * in the thread. A conversation's row and the unread counts are made of none of it, yet their screens asked again
 * for each one: a campaign going out is a run of them, heard by every open tab.
 */
export const DELIVERY_RECEIPTS: readonly string[] = [
  'message.sent',
  'message.delivered',
  'message.read',
  'message.failed',
  'message.bounced',
  'message.complained',
];
/** How long a run of `seldom` events is gathered before it asks once. */
const SELDOM_WAIT_MS = 4_000;

function matches(
  change: Parameters<Listener>[0],
  entityTypes: readonly string[] | undefined,
  only: LiveOptions['only'],
): boolean {
  if (change.entityType === '*') return true;
  if (entityTypes && !entityTypes.includes(change.entityType)) return false;
  const ids = only?.[change.entityType];
  const id = 'entityId' in change ? change.entityId : null;
  // The inbox's and money's broadcasts carry no entity id (20261012020500), so one without an id may be ours.
  return !ids || id === null || ids.includes(id);
}

interface Debounced {
  (): void;
  /** Fires now what is waiting, if anything is. */
  flush(): void;
}

/**
 * Trailing debounce that still fires within MAX_WAIT_MS of the first change, so a steady stream of events
 * (a campaign going out) cannot hold the screen stale indefinitely.
 */
function debounced(fire: () => void, ms: number): Debounced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let first = 0;
  const trigger = () => {
    const now = Date.now();
    if (!timer) first = now;
    else if (now - first >= MAX_WAIT_MS) return;
    else clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fire();
    }, ms);
  };
  trigger.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    fire();
  };
  return trigger;
}

interface Gathered {
  (): void;
  /** Drops what is waiting: something else has just asked for the same. */
  cancel(): void;
}

/** Fires once, `ms` after the first of a run of calls. */
function gathered(fire: () => void, ms: number): Gathered {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    timer ??= setTimeout(() => {
      timer = null;
      fire();
    }, ms);
  };
  trigger.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return trigger;
}

/** The deps-stable form of an entity-type list: undefined is every change; [] is none (''). */
function typesKey(entityTypes: readonly string[] | undefined): string | undefined {
  return entityTypes === undefined ? undefined : entityTypes.join(',');
}

/**
 * Refreshes the server-rendered page (debounced) when a teammate changes one of these entity types. Paused while
 * the tab is hidden; it refreshes once when shown again. The page is drawn once for every screen on it that asks,
 * and never again before the one ahead has landed (./redraws.ts).
 */
export function useLiveRefresh(
  entityTypes?: readonly string[],
  debounceMs = 300,
  options?: LiveOptions,
): void {
  const { subscribe, redraws } = useContext(LiveContext);
  const [me] = useState(() => ({}));
  const key = typesKey(entityTypes);
  const onlyKey = options?.only ? JSON.stringify(options.only) : undefined;
  const whileHidden = options?.whileHidden ?? false;
  useEffect(() => {
    if (key === '') return;
    const types = key === undefined ? undefined : key.split(',');
    const only = onlyKey === undefined ? undefined : (JSON.parse(onlyKey) as LiveOptions['only']);
    let heard = 0;
    const trigger = debounced(() => redraws.ask(me, heard), debounceMs);
    const unsubscribe = subscribe((change) => {
      if (!matches(change, types, only)) return;
      heard = Date.now();
      trigger();
    }, whileHidden);
    return () => {
      unsubscribe();
      // What was heard is still wanted when only what is listened for has changed.
      trigger.flush();
    };
  }, [subscribe, redraws, me, key, onlyKey, debounceMs, whileHidden]);
  // After the effect above, so a screen that goes takes back what it has just asked for.
  useEffect(() => () => redraws.forget(me), [redraws, me]);
}

/**
 * A counter that bumps (debounced) on matching changes, for components that fetch their own data. Paused while
 * the tab is hidden (one resync on return) unless `whileHidden`.
 */
export function useLiveVersion(
  entityTypes?: readonly string[],
  debounceMs = 300,
  options?: LiveOptions,
): number {
  const { subscribe } = useContext(LiveContext);
  const [version, setVersion] = useState(0);
  const key = typesKey(entityTypes);
  const onlyKey = options?.only ? JSON.stringify(options.only) : undefined;
  const seldomKey = options?.seldom?.join(',');
  const whileHidden = options?.whileHidden ?? false;
  useEffect(() => {
    if (key === '') return;
    const types = key === undefined ? undefined : key.split(',');
    const only = onlyKey === undefined ? undefined : (JSON.parse(onlyKey) as LiveOptions['only']);
    const seldom = seldomKey?.split(',');
    const later = gathered(() => setVersion((v) => v + 1), SELDOM_WAIT_MS);
    const trigger = debounced(() => {
      // What the gathered ones wanted is asked for now.
      later.cancel();
      setVersion((v) => v + 1);
    }, debounceMs);
    return subscribe((change) => {
      if (!matches(change, types, only)) return;
      if (seldom?.includes(change.type)) later();
      else trigger();
    }, whileHidden);
  }, [subscribe, key, onlyKey, seldomKey, debounceMs, whileHidden]);
  return version;
}

/**
 * Tells this tab's screens that these entity types changed, as a broadcast would, without anything being sent: the
 * demo player's scenes (lib/demo) use it after making up a message or a draft. No id, so every screen showing one
 * of these types fetches again.
 */
export function emitLocalChange(entityTypes: readonly string[]): void {
  const at = new Date().toISOString();
  for (const entityType of entityTypes)
    window.dispatchEvent(
      new CustomEvent<LiveChange>(LOCAL_CHANGE_EVENT, {
        detail: {
          id: crypto.randomUUID(),
          type: 'local',
          entityType,
          entityId: null,
          actorId: null,
          correlationId: null,
          at,
        },
      }),
    );
}

export function useLiveConnected(): boolean {
  return useContext(LiveContext).connected;
}
