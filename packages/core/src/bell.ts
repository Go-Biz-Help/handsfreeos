/**
 * Notifications under the bell (20261027012600; the owner, 26 Oct 2026). Every push a person's phones were handed is
 * kept for them for 30 days, and the bell beside Ask HandsFreeOS lists them, newest first, on the phone and on the
 * web: pressing one opens the screen its push opens. Browser-safe: both bells say these words and count this way.
 *
 * - **What it counts:** the notifications not seen yet (opening the bell sees them), and the add-ons' alerts still
 *   open that none of those already counts. An alert stays counted until it's done (decision 82 in docs/outreach.md),
 *   even one the business was closed for, which was never pushed.
 * - **New and unread:** a notification is new until the bell is opened with it in the list, and unread until it's
 *   pressed, in the bell or as the push itself. The list marks the unread ones.
 * - **One line per thing:** a push that replaces an earlier one on the phone (a conversation's next message, a
 *   check-in's "is OK") replaces its line too, and comes back to the top as new.
 */
import { relativeTimeAgo } from './workflows/approval-words';

/** How long a notification stays under the bell (private.delete_old_notifications). */
export const NOTIFICATIONS_KEPT_DAYS = 30;

export const BELL_WORDS = {
  title: 'Notifications',
  /** The bell's own name, with its count. */
  label: (n: number) =>
    n === 0 ? 'Notifications' : n === 1 ? 'Notifications: 1 new' : `Notifications: ${n} new`,
  /** Under the title, while there's anything to show. */
  about: `What HandsFreeOS sent to your phone in the last ${NOTIFICATIONS_KEPT_DAYS} days. Press one to open it.`,
  /** With nothing kept and no alert open. */
  none: `Nothing yet. What HandsFreeOS sends to your phone shows up here for ${NOTIFICATIONS_KEPT_DAYS} days.`,
  /** Over the add-ons' alerts still open, kept at the top until each is done. */
  needsYou: 'Needs you',
  /** Over the notifications, when alerts are above them. */
  recent: 'Recent',
  /** A notification not pressed yet, for a screen reader. */
  unread: 'Not opened yet',
  /** Under the list, when older ones are kept. */
  older: 'Show older',
  /** The list couldn't be read. */
  failed: 'Your notifications didn’t load. Try again in a minute.',
} as const;

/** When it came: "just now", "12 min ago", "3 h ago", "2 d ago", then the day ("Sep 9"). */
export const bellTime = (sentAt: string, now = Date.now()): string => relativeTimeAgo(sentAt, now);

/** What the bell needs of a notification to count it. */
export interface BellCounted {
  readonly seenAt: string | null;
  /** The add-on alert its push was about (`refs.alertId`), if any. */
  readonly alertId?: string | null;
}

/**
 * The bell's count: notifications not seen yet, and open alerts that none of those already counts (an alert's push
 * and the alert are one thing to look at).
 */
export function bellCount(
  notifications: readonly BellCounted[],
  openAlertIds: readonly string[] = [],
): number {
  const unseen = notifications.filter((n) => !n.seenAt);
  const counted = new Set(unseen.flatMap((n) => (n.alertId ? [n.alertId] : [])));
  return unseen.length + openAlertIds.filter((id) => !counted.has(id)).length;
}

/** The newest `sentAt` of a list (ISO strings compare in time order), for `notification.seen`'s `upTo`. */
export function newestSent(notifications: readonly { readonly sentAt: string }[]): string | null {
  let newest: string | null = null;
  for (const n of notifications) if (newest === null || n.sentAt > newest) newest = n.sentAt;
  return newest;
}
