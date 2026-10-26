'use client';
import { bellCount, newestSent } from '@hfos/core';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiBrowser, unwrap } from '@/lib/api/client';
import type { AttentionItem, BellItem } from '@/lib/api/types';
import { useLiveVersion } from './live-provider';

/** An add-on's alert still open in this business: kept at the top of the bell until it's done. */
export interface BellAlert {
  readonly id: string;
  readonly alertId: string;
  readonly addonName: string;
  readonly title: string;
  readonly detail: string | null;
  /** Its page, under the business (`/a/<addon>/…`). */
  readonly href: string;
}

interface NotificationsValue {
  /** Off while viewing the business as a teammate: the bell is the signed-in person's own. */
  readonly enabled: boolean;
  /** Read at least once. */
  readonly loaded: boolean;
  /** The last read failed, and nothing is listed. */
  readonly failed: boolean;
  /** Newest first, from every business the person is in. */
  readonly list: readonly BellItem[];
  readonly alerts: readonly BellAlert[];
  /** What the bell counts: what's new, and the alerts still open that none of those already counts. */
  readonly count: number;
  /** Older ones are kept beyond the list. */
  readonly more: boolean;
  readonly isSeen: (n: BellItem) => boolean;
  readonly isRead: (n: BellItem) => boolean;
  /** The bell was opened (and again as it closes): everything it showed is seen. */
  readonly seeAll: () => void;
  /** One pressed: read. */
  readonly read: (n: BellItem) => void;
  readonly loadOlder: () => void;
  /** The bell closed: read the newest again, without the older pages. */
  readonly reset: () => void;
}

const NotificationsContext = createContext<NotificationsValue>({
  enabled: false,
  loaded: false,
  failed: false,
  list: [],
  alerts: [],
  count: 0,
  more: false,
  isSeen: () => true,
  isRead: () => true,
  seeAll: () => {},
  read: () => {},
  loadOlder: () => {},
  reset: () => {},
});

const PAGE = 30;
/** One from another business has no channel here: the list is read again this often while the tab is in view. */
const EVERY_MS = 60_000;

interface Page {
  readonly list: readonly BellItem[];
  readonly unseen: number;
  readonly nextCursor: string | null;
}

const alertOf = (i: AttentionItem): BellAlert[] =>
  i.state === 'open' && i.addonAlert
    ? [
        {
          id: i.id,
          alertId: i.addonAlert.alertId,
          addonName: i.addonAlert.addonName,
          title: i.title,
          detail: i.detail,
          href: i.addonAlert.href,
        },
      ]
    : [];

/**
 * The bell's notifications (20261027012600, packages/core/src/bell.ts): what HandsFreeOS sent to this person's phones
 * in the last 30 days, from every business they're in, with the add-ons' alerts still open in this business. The list
 * is read on mount, when one is kept in this business (`notification.kept` on its channel), every minute while the
 * tab is in view, and when the tab comes back; the alerts when an item here changes. Opening the bell sees what it
 * showed, and pressing one reads it: both show at once, before HandsFreeOS's answer.
 */
export function NotificationsProvider({
  workspaceId,
  enabled,
  children,
}: {
  workspaceId: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const [first, setFirst] = useState<Page | null>(null);
  const [older, setOlder] = useState<{ list: readonly BellItem[]; nextCursor: string | null }>({
    list: [],
    nextCursor: null,
  });
  const [failed, setFailed] = useState(false);
  const [alerts, setAlerts] = useState<readonly BellAlert[]>([]);
  const [seenUpTo, setSeenUpTo] = useState<string | null>(null);
  const [readHere, setReadHere] = useState<ReadonlySet<string>>(() => new Set());
  const [tick, setTick] = useState(0);
  const kept = useLiveVersion(['notification'], 500);
  const items = useLiveVersion(['attention_item'], 1_000);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/notification.list', { body: { limit: PAGE } })
      .then((r) => {
        const out = unwrap(r);
        if (cancelled) return;
        setFirst({ list: out.notifications, unseen: out.unseen, nextCursor: out.nextCursor });
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, kept, tick]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiBrowser()
      .POST('/v1/queries/attention.list', {
        body: { workspaceId, scope: 'everyone', kinds: ['addon_alert'] },
      })
      .then((r) => {
        const out = unwrap(r);
        if (!cancelled) setAlerts(out.items.flatMap(alertOf));
      })
      .catch(() => {
        // The bell still lists the notifications; Home shows the alerts.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workspaceId, items]);

  useEffect(() => {
    if (!enabled) return;
    const again = () => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    };
    const timer = setInterval(again, EVERY_MS);
    document.addEventListener('visibilitychange', again);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', again);
    };
  }, [enabled]);

  const value = useMemo((): NotificationsValue => {
    const top = first?.list ?? [];
    const ids = new Set(top.map((n) => n.id));
    const last = top[top.length - 1];
    // Older pages go on below the newest, without what the newest already has (a line that came back to the top).
    const below = last
      ? older.list.filter((n) => !ids.has(n.id) && n.sentAt <= last.sentAt)
      : older.list;
    const list = [...top, ...below];
    const isRead = (n: BellItem) => n.readAt !== null || readHere.has(n.id);
    const isSeen = (n: BellItem) =>
      n.seenAt !== null || isRead(n) || (seenUpTo !== null && n.sentAt <= seenUpTo);
    const fresh = list.filter((n) => !isSeen(n));
    // New ones beyond what's listed: older than all of it, so seen once the bell has been opened over the oldest.
    const oldest = list[list.length - 1];
    const beyond =
      seenUpTo !== null && oldest !== undefined && oldest.sentAt <= seenUpTo
        ? 0
        : Math.max(0, (first?.unseen ?? 0) - list.filter((n) => !n.seenAt).length);
    const count =
      bellCount(
        fresh.map((n) => ({ seenAt: null, alertId: n.alertId })),
        alerts.map((a) => a.alertId),
      ) + beyond;
    const cursor = older.list.length ? older.nextCursor : (first?.nextCursor ?? null);
    return {
      enabled,
      loaded: first !== null,
      failed: failed && first === null,
      list,
      alerts,
      count,
      more: cursor !== null,
      isSeen,
      isRead,
      seeAll: () => {
        if (fresh.length === 0 && beyond === 0) return;
        const upTo = newestSent(list);
        if (!upTo) return;
        setSeenUpTo((prev) => (prev && prev > upTo ? prev : upTo));
        void apiBrowser()
          .POST('/v1/commands/notification.seen', { body: { upTo } })
          .catch(() => undefined);
      },
      read: (n) => {
        if (isRead(n)) return;
        setReadHere((prev) => new Set([...prev, n.id]));
        void apiBrowser()
          .POST('/v1/commands/notification.read', { body: { ids: [n.id] } })
          .catch(() => undefined);
      },
      loadOlder: () => {
        if (!cursor) return;
        void apiBrowser()
          .POST('/v1/queries/notification.list', { body: { limit: PAGE, cursor } })
          .then((r) => {
            const out = unwrap(r);
            setOlder((prev) => ({
              list: [...prev.list, ...out.notifications],
              nextCursor: out.nextCursor,
            }));
          })
          .catch(() => undefined);
      },
      reset: () => {
        setOlder({ list: [], nextCursor: null });
        setTick((t) => t + 1);
      },
    };
  }, [enabled, first, older, failed, alerts, seenUpTo, readHere]);

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext);
}
