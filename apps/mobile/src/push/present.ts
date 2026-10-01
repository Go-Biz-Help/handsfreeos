import { isStaffPush, type PushCategory, type PushData } from '@hfos/core';

import type { FollowUp } from './press';
import { notificationIdentifierOf } from './payload';

/**
 * Showing a push on the phone (apps/worker/src/push/README.md, "How a push travels"):
 *
 * - **Android** pushes are data-only, so nothing is drawn by the system: the app shows each as a notification of its
 *   own, with the category's buttons, from `data.title`, `data.subtitle` (Android's small line) and `data.body`.
 * - **One notification per conversation:** it's shown under the push's `collapseId` when it has one, so a newer push
 *   about the same conversation replaces the older one rather than adding another.
 * - **Quiet updates** (`quiet: true`, the next messages of a burst) replace the notification without a sound or a buzz.
 * - **iPhones** draw their pushes themselves. Test builds show the worker's stand-in pushes the same way on both
 *   phones, through this code: the words, the category's buttons, time-sensitive for the urgent kinds.
 * - A push for someone not signed in on this phone, or for a business they aren't part of, isn't shown. A push to
 *   HandsFreeOS's support people (a new ticket) belongs to no business: it's shown only to someone who answers support.
 */

/** The phone's one channel for HandsFreeOS notifications (Android). */
export const CHANNEL_ID = 'hfos';
export const CHANNEL_NAME = 'Notifications';

/** The urgent kinds, which break through Focus on an iPhone (with the time-sensitive entitlement). */
export const TIME_SENSITIVE: ReadonlySet<PushCategory> = new Set([
  'customer_waiting',
  'customer_waiting_no_ai',
  'urgent_lead',
  'urgent_lead_no_ai',
]);

/** A notification as `Notifications.scheduleNotificationAsync` takes it, shown at once. */
export interface LocalNotification {
  readonly identifier: string;
  readonly content: {
    readonly title: string;
    readonly subtitle?: string;
    readonly body: string;
    readonly data: Record<string, unknown>;
    readonly categoryIdentifier?: string;
    readonly sound: 'default' | false;
    readonly priority?: 'max' | 'high' | 'default';
    readonly interruptionLevel?: 'passive' | 'active' | 'timeSensitive';
    readonly autoDismiss: boolean;
  };
  /** Android: the channel it's shown on. iPhone: none (at once). */
  readonly trigger: { readonly channelId: string } | null;
}

/** The notification for a push, or null when it has no words to show (an iPhone push's words travel beside `data`). */
export function notificationOf(
  data: PushData,
  platform: 'ios' | 'android',
): LocalNotification | null {
  const title = data.title?.trim();
  if (!title) return null;
  const quiet = data.quiet === true;
  return {
    identifier: notificationIdentifierOf(data),
    content: {
      title,
      ...(data.subtitle ? { subtitle: data.subtitle } : {}),
      body: data.body ?? '',
      data: { ...data },
      categoryIdentifier: data.category,
      sound: quiet ? false : 'default',
      ...(platform === 'android'
        ? { priority: quiet ? ('default' as const) : ('max' as const) }
        : {
            interruptionLevel: quiet
              ? ('passive' as const)
              : TIME_SENSITIVE.has(data.category)
                ? ('timeSensitive' as const)
                : ('active' as const),
          }),
      autoDismiss: true,
    },
    trigger: platform === 'android' ? { channelId: CHANNEL_ID } : null,
  };
}

/**
 * What a press left to say, in place of the push's notification: "Unlock your phone to send your reply.", the API's
 * words, a question to open. It has no buttons (a tap opens the app) and makes no sound: the person just pressed.
 */
export function followUpNotificationOf(
  followUp: FollowUp,
  platform: 'ios' | 'android',
): LocalNotification {
  const { data } = followUp;
  return {
    identifier: notificationIdentifierOf(data),
    content: {
      title: followUp.title,
      ...(data.subtitle ? { subtitle: data.subtitle } : {}),
      body: followUp.body,
      data: {
        ...data,
        title: followUp.title,
        body: followUp.body,
        followUp: {
          kind: followUp.kind,
          ...(followUp.changeId ? { changeId: followUp.changeId } : {}),
        },
      },
      sound: false,
      ...(platform === 'android'
        ? { priority: 'default' as const }
        : { interruptionLevel: 'passive' as const }),
      autoDismiss: true,
    },
    trigger: platform === 'android' ? { channelId: CHANNEL_ID } : null,
  };
}

/** Who is signed in on this phone, as a push asks: their businesses, and whether they answer HandsFreeOS support. */
export interface PhonePerson {
  readonly businessIds: readonly string[];
  /** The kept answer to `platform.me` (admin/staff.ts): a support person. */
  readonly staff: boolean;
}

/**
 * Whether a push is for the person signed in here: one of their businesses', or, for a push to support people (which
 * has no business), someone who answers support. Nobody signed in: nothing is.
 */
export function pushIsFor(data: PushData, person: PhonePerson | null): boolean {
  if (!person) return false;
  if (isStaffPush(data.category)) return data.workspaceId === null && person.staff;
  return data.workspaceId !== null && person.businessIds.includes(data.workspaceId);
}

export type PresentResult = 'shown' | 'already-shown' | 'not-for-this-phone' | 'no-words';

export interface PresenterDeps {
  readonly platform: 'ios' | 'android';
  readonly schedule: (notification: LocalNotification) => Promise<void>;
  /** Someone is signed in here and the push's business is one of theirs. */
  readonly forThisPhone: (data: PushData) => boolean;
  readonly now?: () => number;
}

/** How long a moment's notification is remembered as shown: a push heard twice (the task and a listener) shows once. */
const SHOWN_KEPT_MS = 10 * 60_000;

export class Presenter {
  private readonly shown = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly deps: PresenterDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Shows a push. A push already shown (the same moment heard twice) isn't shown again, unless `again` (test builds
   * showing a stand-in push once more, to press its button twice).
   */
  async present(data: PushData, options: { again?: boolean } = {}): Promise<PresentResult> {
    if (!this.deps.forThisPhone(data)) return 'not-for-this-phone';
    const notification = notificationOf(data, this.deps.platform);
    if (!notification) return 'no-words';
    const now = this.now();
    for (const [id, at] of this.shown) if (now - at > SHOWN_KEPT_MS) this.shown.delete(id);
    if (!options.again && this.shown.has(data.notificationId)) return 'already-shown';
    this.shown.set(data.notificationId, now);
    await this.deps.schedule(notification);
    return 'shown';
  }
}
