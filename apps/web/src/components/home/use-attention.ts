'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { AttentionLetHandleBody, AttentionList, AttentionScope } from '@/lib/api/types';
import { useLiveVersion } from '@/lib/realtime/live-provider';

/** How often the list is read again, so the ranking and the ticking chips stay current. */
export const TICK_MS = 30_000;
/** How long an item this tab acted on stays hidden while the worker catches up. */
const HIDE_MS = 20_000;

export interface AttentionListState {
  readonly data: AttentionList | null;
  /** Mine or Everyone; null until the server has said which is this person's default. */
  readonly scope: AttentionScope | null;
  readonly setScope: (scope: AttentionScope) => void;
  /** The moment the chips are worded for. */
  readonly now: number;
  readonly error: string | null;
  readonly loading: boolean;
  readonly reload: () => void;
  /** Items this tab just acted on, left out until a read no longer has them (or 20 seconds pass). */
  readonly hidden: ReadonlyMap<string, number>;
  readonly hide: (ids: readonly string[]) => void;
  readonly unhide: (ids: readonly string[]) => void;
}

function prune(h: ReadonlyMap<string, number>, next: AttentionList): ReadonlyMap<string, number> {
  if (!h.size) return h;
  const present = new Set([...next.items.map((i) => i.id), ...next.scheduled.map((s) => s.itemId)]);
  const at = Date.now();
  const out = new Map([...h].filter(([id, since]) => present.has(id) && at - since < HIDE_MS));
  return out.size === h.size ? h : out;
}

/**
 * Home's list: `attention.list` for the chosen scope with today's handled items, read again when an item changes
 * (live), every 30 seconds while the tab is in view, when the tab comes back, and after this tab's own actions (they
 * don't come back over Realtime). The server's first read is used as is.
 */
export function useAttentionList(
  workspaceId: string,
  initial: AttentionList | null,
): AttentionListState {
  const [data, setData] = useState<AttentionList | null>(initial);
  const [scope, setScopeState] = useState<AttentionScope | null>(initial?.scope ?? null);
  const [now, setNow] = useState<number>(() => (initial ? Date.parse(initial.now) : Date.now()));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initial);
  const [nonce, setNonce] = useState(0);
  const [hidden, setHidden] = useState<ReadonlyMap<string, number>>(() => new Map());
  const skip = useRef(initial !== null);
  const live = useLiveVersion(['attention_item'], 400);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      if (document.visibilityState === 'visible') reload();
    };
    const timer = setInterval(tick, TICK_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  useEffect(() => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/attention.list', {
        body: { workspaceId, includeHandled: true, ...(scope ? { scope } : {}) },
      })
      .then((r) => {
        if (cancelled) return;
        const next = unwrap(r);
        setData(next);
        setNow(Date.now());
        setScopeState((s) => s ?? next.scope);
        setError(null);
        setHidden((h) => prune(h, next));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, scope, live, nonce]);

  const setScope = useCallback((next: AttentionScope) => {
    setScopeState(next);
    setLoading(true);
  }, []);
  const hide = useCallback(
    (ids: readonly string[]) =>
      setHidden((h) => {
        const out = new Map(h);
        for (const id of ids) out.set(id, Date.now());
        return out;
      }),
    [],
  );
  const unhide = useCallback(
    (ids: readonly string[]) =>
      setHidden((h) => {
        if (!ids.some((id) => h.has(id))) return h;
        const out = new Map(h);
        for (const id of ids) out.delete(id);
        return out;
      }),
    [],
  );

  return { data, scope, setScope, now, error, loading, reload, hidden, hide, unhide };
}

/** The Action Center's commands and the Let HandsFreeOS Handle preview, as this person. */
export function attentionCommands(workspaceId: string) {
  const api = () => apiBrowser();
  return {
    snooze: async (itemId: string, until: string) =>
      unwrap(
        await api().POST('/v1/commands/attention.snooze', {
          body: { workspaceId, itemId, until },
        }),
      ),
    dismiss: async (itemId: string, reason: string | null) =>
      unwrap(
        await api().POST('/v1/commands/attention.dismiss', {
          body: { workspaceId, itemId, reason },
        }),
      ),
    /** Undo for a snooze or a dismissal. */
    restore: async (itemId: string) =>
      unwrap(await api().POST('/v1/commands/attention.restore', { body: { workspaceId, itemId } })),
    assign: async (itemId: string, assigneeUserId: string | null) =>
      unwrap(
        await api().POST('/v1/commands/attention.assign', {
          body: { workspaceId, itemId, assigneeUserId },
        }),
      ),
    letHandle: async (body: Omit<AttentionLetHandleBody, 'workspaceId'>) =>
      unwrap(
        await api().POST('/v1/commands/attention.let_handle', {
          body: { ...body, workspaceId },
        }),
      ),
    /** Says you've seen an add-on's alert (Real Estate step 5). */
    acknowledge: async (alertId: string) =>
      unwrap(
        await api().POST('/v1/commands/addon_alert.acknowledge', {
          body: { workspaceId, alertId },
        }),
      ),
    cancelAuto: async (itemId: string) =>
      unwrap(
        await api().POST('/v1/commands/attention.cancel_auto', {
          body: { workspaceId, itemId },
        }),
      ),
    preview: async (itemId: string) =>
      unwrap(
        await api().POST('/v1/queries/attention.preview_handle', {
          body: { workspaceId, itemId },
        }),
      ),
  };
}
