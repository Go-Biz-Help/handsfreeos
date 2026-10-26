/**
 * The moments a person can be told about, push beside email: one list for the web's Settings → Account
 * (design/m10/Web.dc.html), the phone's Settings → Notifications (design/m10/More.dc.html, "Notifications: push beside
 * email") and settings search, which finds each row. Browser-safe.
 *
 * The switches belong to the person, not the phone or the business: push goes to every phone they're signed in on,
 * and a change saves the whole group it's in, `user.update_profile` with every push switch (`settings.push`) or every
 * email one (`settings.notifications`). New support tickets is a row only for people who answer HandsFreeOS support.
 */
import { pushSwitchOn, type PushSwitch } from '../push';

/** The email switches, each on unless turned off. */
export interface EmailSwitches {
  /** Something urgent is waiting: a hot lead, a lead nobody answered, or a customer waiting for a reply. */
  readonly unansweredEmail: boolean;
  /** The Action Center's morning summary, at 7 AM where the business is. */
  readonly attentionDigest: boolean;
  /** Automations' end-of-day email, to owners and admins. */
  readonly eveningSummary: boolean;
  /** The AI teammate handed a conversation to you, or to its list when nobody is assigned. */
  readonly aiHandoff: boolean;
  /** Online bookings and cancellations on your appointments (the calendar's team email). */
  readonly bookingEmail: boolean;
  /** An invoice was paid: the short note to whoever it is on, and to the owners and admins. */
  readonly paymentEmail: boolean;
  /** The worker's daily email to an organization's owners and admins about its businesses. */
  readonly agencyDigest: boolean;
  /** What an add-on the business uses needs you to see (Real Estate step 5). */
  readonly addonEmail: boolean;
}
export type EmailSwitch = keyof EmailSwitches;

export interface NotificationRow {
  /** Its key in settings search (`notifications.customer_waiting`), and its anchor on the web's Account page. */
  readonly key: `notifications.${string}`;
  readonly title: string;
  /** The phone's short line under the title. */
  readonly detail: string;
  /** The web's longer explanation. */
  readonly description: string;
  /** Its push switch, or null for a moment that only emails. */
  readonly push: PushSwitch | null;
  /** Its email switch, 'always' for an email that always goes, or null for one that never emails. */
  readonly email: EmailSwitch | 'always' | null;
  /** Only for owners and admins of an agency. */
  readonly agencyOnly?: boolean;
  /** Only for people who answer HandsFreeOS support (`platform.me`, admin/staff.ts). */
  readonly staffOnly?: boolean;
}

const PUSH_ROWS = [
  {
    key: 'notifications.customer_waiting',
    title: 'A customer waiting on a reply',
    detail: 'A text, email or chat nobody answered',
    description: 'A new text, email or website chat that nobody has answered yet.',
    push: 'customerWaiting',
    email: null,
  },
  {
    key: 'notifications.missed_call',
    title: 'A call nobody took',
    detail: 'A missed call, and the voicemail if one was left',
    description:
      'A missed call, and the voicemail if one was left, with what the caller said. It goes to whoever the conversation is assigned to, else the owners and admins.',
    push: 'missedCall',
    email: null,
  },
  {
    key: 'notifications.urgent',
    title: 'Urgent items',
    detail: 'Hot leads, and anyone left waiting',
    description:
      'As soon as something can’t wait: a hot lead, a new lead nobody has answered, or a customer left waiting. Owners and admins also get the ones nobody is assigned to.',
    push: 'urgent',
    email: 'unansweredEmail',
  },
  {
    key: 'notifications.approvals',
    title: 'Approvals',
    detail: 'The AI teammate’s drafts and workflow steps',
    description:
      'A draft from the AI teammate, or a workflow step waiting for your OK. The email always goes.',
    push: 'approval',
    email: 'always',
  },
  {
    key: 'notifications.appointments',
    title: 'Your appointments',
    detail: 'Booked, moved or cancelled',
    description:
      'When one of your appointments is booked, moved or cancelled, online or by the team.',
    push: 'booking',
    email: 'bookingEmail',
  },
  {
    key: 'notifications.assigned',
    title: 'Assigned to you',
    detail: 'Leads, conversations and tasks',
    description: 'When someone gives you a lead, a conversation, a task or an item on Home.',
    push: 'assigned',
    email: null,
  },
  {
    key: 'notifications.qualifying',
    title: 'Your AI teammate’s qualifying',
    detail: 'A lead qualifies, or a customer sends a file',
    description:
      'When a lead qualifies, or a customer sends a file one of its questions asked for, like a photo of a bill. Only to the people its settings name, under AI teammate → Qualify. The email always goes.',
    push: 'qualifying',
    email: 'always',
  },
  {
    key: 'notifications.payments',
    title: 'A customer pays',
    detail: 'An invoice is paid in full',
    description: 'A short note when an invoice is settled, with what it was for and how they paid.',
    push: 'payment',
    email: 'paymentEmail',
  },
  {
    key: 'notifications.balance',
    title: 'Your balance runs out',
    detail: 'Nothing left to text or call with, or the card was declined',
    description:
      'When there is nothing left to send texts and make calls with, or the card that tops it up is declined. Owners and admins only, since they are the ones who can fix it.',
    push: 'wallet',
    email: null,
  },
  {
    key: 'notifications.jobs',
    title: 'A job you were on is over',
    detail: 'Mark it done, or say it didn’t happen',
    description:
      'Half an hour after a visit you were on ends, if nobody has said how it went: mark it done, or say it didn’t happen, from the notification.',
    push: 'jobs',
    email: null,
  },
  {
    key: 'notifications.connections',
    title: 'A connection stops working',
    detail: 'Payments, a calendar, email, reviews or a phone number',
    description:
      'When something you connected stops working: payments, a calendar, your email, reviews or a phone number. Owners and admins, and whoever the calendar or inbox belongs to.',
    push: 'connections',
    email: null,
  },
  {
    key: 'notifications.addons',
    title: 'An add-on needs you',
    detail: 'A duty running late, a deal at risk',
    description:
      'What an add-on your business uses needs you to see, like a duty running late or a deal at risk. Critical ones at any hour; the rest while the business is open.',
    push: 'addons',
    email: 'addonEmail',
  },
  {
    key: 'notifications.support_tickets',
    title: 'New support tickets',
    detail: 'When someone writes to HandsFreeOS support. Only people who answer support get these.',
    description:
      'When someone writes to HandsFreeOS support, in the app or by email. Only people who answer support get these.',
    push: 'supportTickets',
    email: null,
    staffOnly: true,
  },
] as const satisfies readonly NotificationRow[];

const EMAIL_ROWS = [
  {
    key: 'notifications.morning_summary',
    title: 'Morning summary',
    detail: 'At 7 AM, what needs you today',
    description:
      'One email at 7 AM with today’s jobs, who to call, and what needs your attention, urgent first.',
    push: null,
    email: 'attentionDigest',
  },
  {
    key: 'notifications.end_of_day',
    title: 'End-of-day email',
    detail: 'The day in numbers, owners and admins',
    description:
      'One email in the evening with the day in numbers and what’s still open. Owners and admins only.',
    push: null,
    email: 'eveningSummary',
  },
  {
    key: 'notifications.ai_handoff',
    title: 'The AI teammate hands you a conversation',
    detail: 'When the AI teammate needs you',
    description: 'When the AI teammate hands one to you, or to everyone on its hand-off list.',
    push: null,
    email: 'aiHandoff',
  },
  {
    key: 'notifications.agency_digest',
    title: 'Daily agency digest',
    detail: 'At 8 AM, the client businesses that need a look',
    description:
      'One email around 8 AM about the client businesses that need a look: failed workflow runs, approvals waiting, paused workflows and template updates.',
    push: null,
    email: 'agencyDigest',
    agencyOnly: true,
  },
] as const satisfies readonly NotificationRow[];

/** A notification row's key in settings search. */
export type NotificationSettingKey =
  (typeof PUSH_ROWS)[number]['key'] | (typeof EMAIL_ROWS)[number]['key'];

/** A row with its key as settings search knows it, so a screen can mark it. */
export type KeyedNotificationRow = NotificationRow & { readonly key: NotificationSettingKey };

/** The moments that push, in the canvas's words. */
export const NOTIFICATION_ROWS: readonly KeyedNotificationRow[] = PUSH_ROWS;

/** The moments that only email. */
export const EMAIL_ONLY_ROWS: readonly KeyedNotificationRow[] = EMAIL_ROWS;

/**
 * Whether Daily agency digest is one of their rows: an owner or admin of an organization with more than one business
 * (a founder owns an organization of one, and its digest would never have anything in it). The web's Account page,
 * the phone's Notifications and settings search all ask this.
 */
export function managesAnAgency(me: {
  readonly organizations?: readonly { readonly id: string; readonly role: string }[];
  readonly businesses: readonly { readonly organizationId: string }[];
}): boolean {
  return (me.organizations ?? []).some(
    (o) =>
      (o.role === 'owner' || o.role === 'admin') &&
      me.businesses.filter((b) => b.organizationId === o.id).length > 1,
  );
}

/** One moment as the person has it set now: its push and its email, each on, off, always, or not a choice. */
export interface NotificationState {
  readonly title: string;
  /** What it's about, as the screen's line under the title says it. */
  readonly about: string;
  /** Phone alerts: on, off, or null for a moment that never pushes. */
  readonly phone: boolean | null;
  /** Its email: on, off, 'always' for one that always goes, or null for a moment that never emails. */
  readonly email: boolean | 'always' | null;
  /** Only for owners and admins of an agency. */
  readonly agencyOnly?: true;
  /** Only for people who answer HandsFreeOS support. */
  readonly supportOnly?: true;
}

/**
 * Every moment the person can be told about, as Settings → Account shows it to them: each switch as they set it, or
 * its default when they never did (on, but payments' push off until turned on).
 */
export function notificationStates(settings: unknown): NotificationState[] {
  const group =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>)['notifications']
      : undefined;
  const emailOn = (key: EmailSwitch) => {
    const v =
      typeof group === 'object' && group !== null
        ? (group as Record<string, unknown>)[key]
        : undefined;
    return typeof v === 'boolean' ? v : true;
  };
  return [...NOTIFICATION_ROWS, ...EMAIL_ONLY_ROWS].map((r) => ({
    title: r.title,
    about: r.description,
    phone: r.push ? pushSwitchOn(settings, r.push) : null,
    email: r.email === 'always' ? 'always' : r.email ? emailOn(r.email) : null,
    ...(r.agencyOnly ? { agencyOnly: true as const } : {}),
    ...(r.staffOnly ? { supportOnly: true as const } : {}),
  }));
}
