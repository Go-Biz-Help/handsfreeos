import { useSyncExternalStore } from 'react';

import { change } from '@/changes';
import type { NotificationsRow } from '@/sync/schema';

/**
 * The bell's notifications on this phone (20261027012600, packages/core/src/bell.ts): every push the person's phones
 * were handed in the last 30 days about the business on screen, from their own copy (me_v1), newest first. Only that
 * business's (the owner's pick), with the person's own about no business, as `notification.list` gives the web.
 *
 * Opening the bell sees them (`notification.seen`, for that business), and pressing one, in the bell or as the push
 * itself, reads it (`notification.read`). Both need signal and go at once. What this phone marked shows straight away
 * and is kept while the app runs, so the bell on the next screen agrees before the copy catches up; one marked with no
 * signal is marked again the next time.
 */

/** The business's (and the person's own about none), newest first, a page at a time. */
export const BELL_SQL = `
  SELECT id, workspace_id, push_id, category, title, subtitle, body, path, refs, sent_at, seen_at, read_at
  FROM notifications
  WHERE workspace_id = ? OR workspace_id IS NULL
  ORDER BY sent_at DESC, id DESC
  LIMIT ?`;

/** What the bell counts: those of the business not seen yet, wherever they are in the list. */
export const BELL_UNSEEN_SQL = `
  SELECT id, workspace_id, push_id, category, title, subtitle, body, path, refs, sent_at, seen_at, read_at
  FROM notifications
  WHERE (workspace_id = ? OR workspace_id IS NULL) AND seen_at IS NULL`;

/** How many the list shows, and how many more each "Show older" adds. */
export const BELL_PAGE = 50;

export interface BellNotification {
  readonly id: string;
  readonly workspaceId: string | null;
  /** The push it was (its `data.notificationId`). */
  readonly pushId: string;
  readonly category: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly body: string;
  /** The web path its push opens. */
  readonly path: string;
  /** The add-on alert it was about (`refs.alertId`). */
  readonly alertId: string | null;
  readonly sentAt: string;
  readonly seenAt: string | null;
  readonly readAt: string | null;
}

const iso = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function alertIdOf(refs: string | null | undefined): string | null {
  if (!refs) return null;
  try {
    const value = (JSON.parse(refs) as { alertId?: unknown } | null)?.alertId;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** A row of the copy as the bell shows it; null for one it can't (no time, nowhere to open). */
export function bellNotificationOf(
  r: Partial<NotificationsRow> & { readonly id: string },
): BellNotification | null {
  const sentAt = iso(r.sent_at);
  if (!sentAt || !r.path || !r.push_id) return null;
  return {
    id: r.id,
    workspaceId: r.workspace_id ?? null,
    pushId: r.push_id,
    category: r.category ?? '',
    title: r.title ?? '',
    subtitle: r.subtitle || null,
    body: r.body ?? '',
    path: r.path,
    alertId: alertIdOf(r.refs),
    sentAt,
    seenAt: iso(r.seen_at),
    readAt: iso(r.read_at),
  };
}

/** What this phone marked that the copy may not show yet. */
export interface BellMarks {
  readonly userId: string | null;
  /**
   * A business's bell was opened with everything it lists sent up to this in it, by the business's id; under null,
   * the newest of those for the person's own about no business, which every business's bell lists.
   */
  readonly seenUpTo: ReadonlyMap<string | null, string>;
  /** Pressed: notifications' ids, and pushes' ids. */
  readonly read: ReadonlySet<string>;
}

const NONE: BellMarks = { userId: null, seenUpTo: new Map(), read: new Set() };
let marks: BellMarks = NONE;
const listeners = new Set<() => void>();

function publish(next: BellMarks) {
  marks = next;
  for (const listener of listeners) listener();
}

const marksOf = (userId: string): BellMarks =>
  marks.userId === userId ? marks : { ...NONE, userId };

export const bellMarks = {
  current: (): BellMarks => marks,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Signing out: nothing marked here carries over to whoever signs in next. */
  clear(): void {
    publish(NONE);
  },
};

/** This person's marks, as they change. */
export function useBellMarks(userId: string): BellMarks {
  const current = useSyncExternalStore(bellMarks.subscribe, bellMarks.current, bellMarks.current);
  return current.userId === userId ? current : NONE;
}

/** Pressed, by HandsFreeOS's answer or on this phone since. */
export const isRead = (n: BellNotification, m: BellMarks): boolean =>
  n.readAt !== null || m.read.has(n.id) || m.read.has(n.pushId);

/** Seen (the bell was opened with it in the list), by HandsFreeOS's answer or on this phone since. */
export const isSeen = (n: BellNotification, m: BellMarks): boolean => {
  const upTo = m.seenUpTo.get(n.workspaceId);
  return n.seenAt !== null || isRead(n, m) || (upTo !== undefined && n.sentAt <= upTo);
};

/**
 * A business's bell was opened with everything sent up to `upTo` in it (the newest it showed): its count leaves them
 * out from now on, and any that came in after stay new, as do other businesses'.
 */
export function markSeen(userId: string, workspaceId: string, upTo: string | null): void {
  if (!upTo) return;
  const current = marksOf(userId);
  const seenUpTo = new Map(current.seenUpTo);
  // The business's own, and the person's own about no business: its bell listed both.
  for (const key of [workspaceId, null]) {
    const was = seenUpTo.get(key);
    if (was === undefined || was < upTo) seenUpTo.set(key, upTo);
  }
  publish({ ...current, seenUpTo });
  void change('notification.seen', { workspaceId, upTo }).catch(() => undefined);
}

/** Pressed, in the bell (`id`) or as the push itself (`pushId`): read, and seen. */
export function markRead(userId: string, which: { id: string } | { pushId: string }): void {
  const current = marksOf(userId);
  const key = 'id' in which ? which.id : which.pushId;
  if (current.read.has(key)) return;
  publish({ ...current, read: new Set([...current.read, key]) });
  void change(
    'notification.read',
    'id' in which ? { ids: [which.id] } : { pushIds: [which.pushId] },
  ).catch(() => undefined);
}
