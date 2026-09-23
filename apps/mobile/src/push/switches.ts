import { pushSwitchesOf, type PushSwitch, type PushSwitches } from '@hfos/core';

import type { Me } from '@/lib/businesses';

/**
 * Settings → Notifications on the phone (design/m10/More.dc.html, "Notifications: push beside email"): a push switch
 * for each moment beside today's email switches, the same switches as the web's Settings → Account. They belong to the
 * person, not the phone: push goes to every phone they're signed in on. A change saves the whole group it's in, as the
 * web does: `user.update_profile` with all seven push switches (`settings.push`), or all seven email ones
 * (`settings.notifications`).
 */

/** The email switches, as the web names them (apps/web/src/components/settings/notifications-section.tsx). */
export interface EmailSwitches {
  readonly unansweredEmail: boolean;
  readonly attentionDigest: boolean;
  readonly eveningSummary: boolean;
  readonly aiHandoff: boolean;
  readonly bookingEmail: boolean;
  readonly paymentEmail: boolean;
  readonly agencyDigest: boolean;
}
export type EmailSwitch = keyof EmailSwitches;

export interface NotificationRow {
  readonly title: string;
  readonly detail: string;
  /** Its push switch, or null for a moment that only emails. */
  readonly push: PushSwitch | null;
  /** Its email switch, 'always' for an email that always goes, or null for one that never emails. */
  readonly email: EmailSwitch | 'always' | null;
  /** Only for owners and admins of an agency. */
  readonly agencyOnly?: boolean;
}

/** The moments, in the canvas's words. */
export const NOTIFICATION_ROWS: readonly NotificationRow[] = [
  {
    title: 'A customer waiting on a reply',
    detail: 'A text, email or chat nobody answered',
    push: 'customerWaiting',
    email: null,
  },
  {
    title: 'A call nobody took',
    detail: 'A missed call, and the voicemail if one was left',
    push: 'missedCall',
    email: null,
  },
  {
    title: 'Urgent items',
    detail: 'Hot leads, and anyone left waiting',
    push: 'urgent',
    email: 'unansweredEmail',
  },
  {
    title: 'Approvals',
    detail: 'The AI teammate’s drafts and workflow steps',
    push: 'approval',
    email: 'always',
  },
  {
    title: 'Your appointments',
    detail: 'Booked, moved or cancelled',
    push: 'booking',
    email: 'bookingEmail',
  },
  {
    title: 'Assigned to you',
    detail: 'Leads, conversations and tasks',
    push: 'assigned',
    email: null,
  },
  {
    title: 'A customer pays',
    detail: 'An invoice is paid in full',
    push: 'payment',
    email: 'paymentEmail',
  },
  {
    title: 'Your balance runs out',
    detail: 'Nothing left to text or call with, or the card was declined',
    push: 'wallet',
    email: null,
  },
];

/** The moments that only email. */
export const EMAIL_ONLY_ROWS: readonly NotificationRow[] = [
  {
    title: 'Morning summary',
    detail: 'At 7 AM, what needs you today',
    push: null,
    email: 'attentionDigest',
  },
  {
    title: 'End-of-day email',
    detail: 'The day in numbers, owners and admins',
    push: null,
    email: 'eveningSummary',
  },
  {
    title: 'The AI teammate hands you a conversation',
    detail: 'When the AI teammate needs you',
    push: null,
    email: 'aiHandoff',
  },
  {
    title: 'Daily agency digest',
    detail: 'At 8 AM, the client businesses that need a look',
    push: null,
    email: 'agencyDigest',
    agencyOnly: true,
  },
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The person's settings, from the synced profile's JSON text (or an object). */
export function settingsOf(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}

/** The six push switches, defaults filled in (payments off until turned on). */
export function pushSwitchesFrom(settings: unknown): PushSwitches {
  return pushSwitchesOf(settingsOf(settings));
}

/** The seven email switches, each on unless turned off, as the web reads them. */
export function emailSwitchesFrom(settings: unknown): EmailSwitches {
  const stored = settingsOf(settings)['notifications'];
  const n = isRecord(stored) ? stored : {};
  const on = (key: EmailSwitch) => n[key] !== false;
  return {
    unansweredEmail: on('unansweredEmail'),
    attentionDigest: on('attentionDigest'),
    eveningSummary: on('eveningSummary'),
    aiHandoff: on('aiHandoff'),
    bookingEmail: on('bookingEmail'),
    paymentEmail: on('paymentEmail'),
    agencyDigest: on('agencyDigest'),
  };
}

/** An owner or admin of an organization with more than one business: the agency digest's row shows. */
export function managesAnAgency(me: Pick<Me, 'organizations' | 'businesses'>): boolean {
  return (me.organizations ?? []).some(
    (o) =>
      (o.role === 'owner' || o.role === 'admin') &&
      me.businesses.filter((b) => b.organizationId === o.id).length > 1,
  );
}

/** "On 2 phones", as the web says it. */
export function phonesWords(count: number): string {
  return count === 0 ? 'No phones yet' : count === 1 ? 'On 1 phone' : `On ${count} phones`;
}

/** What a saved switch says: "Urgent items: push off". */
export function savedWords(row: NotificationRow, channel: 'push' | 'email', on: boolean): string {
  return `${row.title}: ${channel} ${on ? 'on' : 'off'}`;
}
