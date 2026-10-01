/**
 * What a push says and carries, and its two shapes (M10). A moment becomes one notice (queue.ts); each phone gets a
 * message built from it here:
 * - **iPhone:** a normal alert push. The title, subtitle and body show on the lock screen, `categoryId` gives it
 *   its buttons (the app registers them), and `data` carries the rest.
 * - **Android:** a data-only, high-priority push the app draws itself, the only way its buttons work whatever state
 *   the app is in, so the words travel in `data` beside everything else.
 * - **Replacing, not adding:** a push about a conversation carries its `collapseId`, so it takes the place of that
 *   conversation's earlier notification. A `quiet` one (the next message of a burst) does so without a sound: on
 *   an iPhone it goes in passively; Android's app updates its notification without alerting again.
 *
 * The words are short, the business is named on each (people work in more than one), and nothing secret goes in:
 * no customer links with their codes, no tokens, no provider ids. README.md is the contract the app builds on.
 * A push to HandsFreeOS's own support people (`support_ticket`) is the one about no business: its workspace is null
 * and it opens the support desk.
 */
import {
  PUSH_DATA_VERSION,
  type PushButton,
  PUSH_TEXT_MAX,
  type PushCategory,
  type PushData,
  type PushRefs,
} from '@hfos/core';
import type { PushMessage, PushPlatform } from './provider';

/** What a lock screen shows before it cuts off: core's, which words a support push to fit. */
export const PUSH_WORDS = PUSH_TEXT_MAX;

const HOUR_S = 3_600;

/** How long Apple and Google keep trying a phone that is off or out of signal, by kind (seconds). */
export const PUSH_TTL_SECONDS: Readonly<Record<PushCategory, number>> = {
  customer_message: 12 * HOUR_S,
  customer_message_no_ai: 12 * HOUR_S,
  customer_waiting: 12 * HOUR_S,
  customer_waiting_no_ai: 12 * HOUR_S,
  urgent_lead: 12 * HOUR_S,
  urgent_lead_no_ai: 12 * HOUR_S,
  // A missed call is worth hearing about late, but a day-old one is history: the inbox has it either way.
  missed_call: 12 * HOUR_S,
  voicemail: 12 * HOUR_S,
  approval: 24 * HOUR_S,
  booking: 24 * HOUR_S,
  assigned: 24 * HOUR_S,
  payment: 24 * HOUR_S,
  // A balance that has run out stays run out: worth telling a phone that comes back on tomorrow.
  wallet: 24 * HOUR_S,
  // By the next morning the card on Home has it.
  job_check: 12 * HOUR_S,
  // Broken until someone reconnects it: still worth hearing about tomorrow.
  connection: 24 * HOUR_S,
  // A late duty is still late tomorrow, and Home has it either way.
  addon_alert: 24 * HOUR_S,
  // Someone waiting on HandsFreeOS, like a customer's message to a business; by tomorrow the desk's queue has it.
  support_ticket: 12 * HOUR_S,
};

/**
 * The urgent kinds, which may break through an iPhone's Focus (with the app's time-sensitive entitlement; without it
 * they arrive as ordinary ones): someone has been left waiting. A new message arrives the ordinary way.
 */
const TIME_SENSITIVE: ReadonlySet<PushCategory> = new Set([
  'customer_waiting',
  'customer_waiting_no_ai',
  'urgent_lead',
  'urgent_lead_no_ai',
]);

/** One moment, ready for every phone that should hear it. */
export interface PushNotice {
  readonly notificationId: string;
  readonly category: PushCategory;
  /** The business; null for a push to HandsFreeOS's support people, which is about none. */
  readonly workspaceId: string | null;
  /** The business's name; empty for a push about none. */
  readonly business: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly body: string;
  /** /app/w/<business>/…: a web path, as the emails link (the support desk's /admin/… for a push to support). */
  readonly path: string;
  readonly refs: PushRefs;
  readonly commandIds: Partial<Record<PushButton, string>>;
  /** When the moment was queued (ISO). */
  readonly sentAt: string;
  /** The notification it replaces (`conversation-<id>`), or null. */
  readonly collapseId?: string | null;
  /** An update to a notification already showing: no sound, no buzz. */
  readonly quiet?: boolean;
}

/** What every push carries, on both phones. */
export function noticeData(n: PushNotice): PushData {
  return {
    v: PUSH_DATA_VERSION,
    notificationId: n.notificationId,
    category: n.category,
    workspaceId: n.workspaceId,
    business: n.business,
    path: n.path,
    sentAt: n.sentAt,
    refs: n.refs,
    commandIds: n.commandIds,
    ...(n.collapseId ? { collapseId: n.collapseId } : {}),
    ...(n.quiet ? { quiet: true } : {}),
  };
}

/** The message for one phone: an alert with a category on an iPhone, data only on Android. */
export function messageFor(
  device: { readonly platform: PushPlatform; readonly token: string },
  n: PushNotice,
): PushMessage {
  const base = { to: device.token, priority: 'high', ttl: PUSH_TTL_SECONDS[n.category] } as const;
  if (device.platform === 'android')
    return {
      ...base,
      data: { ...noticeData(n), title: n.title, subtitle: n.subtitle, body: n.body },
    };
  return {
    ...base,
    title: n.title,
    ...(n.subtitle ? { subtitle: n.subtitle } : {}),
    body: n.body,
    categoryId: n.category,
    ...(n.collapseId ? { collapseId: n.collapseId, threadId: n.collapseId } : {}),
    ...(n.quiet
      ? { interruptionLevel: 'passive' as const }
      : {
          sound: 'default' as const,
          interruptionLevel: TIME_SENSITIVE.has(n.category) ? 'time-sensitive' : 'active',
        }),
    data: { ...noticeData(n) },
  };
}
