/**
 * The support desk's words (M13), said once for the web's /admin and the phone's Support desk. The screens differ;
 * what they call things, which sections a support person sees and what the queue's tabs ask for do not.
 */

import type { StaffRole } from '../permissions';

export type TicketStatus = 'new' | 'open' | 'waiting_on_customer' | 'solved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketChannel = 'email' | 'in_app' | 'chat';

/** The desk's sections, in the menu's order. The web opens each at `/admin/<key>`, the phone at `/app/admin/<key>`. */
export const DESK_SECTIONS = [
  { key: 'tickets', label: 'Tickets' },
  // Ideas, the roadmap and What's new (0102): every support role answers them; leads and admins move them.
  { key: 'ideas', label: 'Ideas', needs: 'platform.ideas.moderate' },
  // Voting on what's next (0109): the weekly pick, and choosing one when a week has no winner.
  { key: 'add-ons', label: 'Add-on votes', needs: 'platform.addons.manage' },
  { key: 'businesses', label: 'Businesses', needs: 'platform.businesses.read' },
  // How Getting started is going, everywhere: its skips and finishes, counted (the onboarding plan's §9).
  { key: 'getting-started', label: 'Getting started', needs: 'platform.businesses.read' },
  { key: 'health', label: 'Health', needs: 'platform.health.read' },
  { key: 'rates', label: 'Rates', needs: 'platform.rates.manage' },
  { key: 'founding', label: 'Founding', needs: 'platform.founding.manage' },
  { key: 'replies', label: 'Saved replies' },
  { key: 'staff', label: 'Support people' },
] as const satisfies readonly { key: string; label: string; needs?: string }[];

export type DeskSection = (typeof DESK_SECTIONS)[number];
export type DeskSectionKey = DeskSection['key'];

/** The sections a support person with these permissions sees; the rest are left out of the menu, not greyed. */
export function deskSectionsFor(permissions: readonly string[]): readonly DeskSection[] {
  return DESK_SECTIONS.filter((s) => !('needs' in s) || permissions.includes(s.needs));
}

/** A section's name, as its page's title says it. */
export const deskSectionLabel = (key: DeskSectionKey): string =>
  DESK_SECTIONS.find((s) => s.key === key)?.label ?? key;

export const STAFF_ROLE_WORDS: Readonly<Record<StaffRole, string>> = {
  agent: 'Support agent',
  lead: 'Support lead',
  admin: 'Support admin',
};

export const TICKET_STATUS_WORDS: Readonly<Record<TicketStatus, string>> = {
  new: 'New',
  open: 'Open',
  waiting_on_customer: 'Waiting on them',
  solved: 'Solved',
  closed: 'Closed',
};

export const TICKET_CHANNEL_WORDS: Readonly<Record<TicketChannel, string>> = {
  email: 'By email',
  in_app: 'From inside the app',
  chat: 'From the website chat',
};

export const TICKET_PRIORITY_WORDS: Readonly<Record<TicketPriority, string>> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** A line in a ticket's "What happened". A kind nobody has named yet shows as itself. */
export const TICKET_EVENT_WORDS: Readonly<Record<string, string>> = {
  opened: 'Opened',
  customer_replied: 'They wrote again',
  acknowledged: 'We said it arrived',
  status_changed: 'Status changed',
  priority_changed: 'Priority changed',
  assigned: 'Given to someone',
  snoozed: 'Put down for later',
  unsnoozed: 'Picked back up',
  linked_business: 'Linked to a business',
  merged_in: 'Another ticket folded in',
  merged_into: 'Folded into another ticket',
};

/** The queue's tabs, "Needs an answer" first: it is the one that matters. */
export const TICKET_QUEUE_FILTERS = [
  { key: 'unanswered', label: 'Needs an answer' },
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Nobody’s' },
  { key: 'waiting', label: 'Waiting on them' },
  { key: 'all', label: 'Everything' },
] as const;

export type TicketQueueFilter = (typeof TICKET_QUEUE_FILTERS)[number]['key'];

/** What each of the queue's tabs asks `support.ticket.list` for. */
export const TICKET_QUEUE_QUERIES: Readonly<
  Record<
    TicketQueueFilter,
    {
      readonly status?: readonly TicketStatus[];
      readonly assignee: 'mine' | 'unassigned' | 'anyone';
    }
  >
> = {
  unanswered: { status: ['new', 'open'], assignee: 'anyone' },
  mine: { status: ['new', 'open', 'waiting_on_customer'], assignee: 'mine' },
  unassigned: { status: ['new', 'open'], assignee: 'unassigned' },
  waiting: { status: ['waiting_on_customer'], assignee: 'anyone' },
  all: { assignee: 'anyone' },
};

/** The count beside a tab, from `support.queue.summary`; Everything has none. */
export function ticketQueueCount(
  filter: TicketQueueFilter,
  counts: {
    readonly unanswered: number;
    readonly mine: number;
    readonly unassigned: number;
    readonly waitingOnCustomer: number;
  },
): number | null {
  switch (filter) {
    case 'unanswered':
      return counts.unanswered;
    case 'mine':
      return counts.mine;
    case 'unassigned':
      return counts.unassigned;
    case 'waiting':
      return counts.waitingOnCustomer;
    case 'all':
      return null;
  }
}

/** "4 minutes", "3 hours", "2 days": how long, said the way a person would say it. */
export function sinceWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** How long since a moment, in `sinceWords`. */
export const sinceIso = (iso: string, now = Date.now()): string =>
  sinceWords(Math.round((now - Date.parse(iso)) / 60_000));

/** The queue's line over the list: "3 solved in the last day · oldest unanswered 2 hours". */
export function ticketQueueSummary(counts: {
  readonly unanswered: number;
  readonly solvedToday: number;
  readonly oldestWaitingMinutes: number | null;
}): string {
  const oldest =
    counts.oldestWaitingMinutes !== null && counts.unanswered > 0
      ? ` · oldest unanswered ${sinceWords(counts.oldestWaitingMinutes)}`
      : '';
  return `${counts.solvedToday} solved in the last day${oldest}`;
}

/** The support desk's other words, where the web and the phone both say them. */
export const DESK_WORDS = {
  title: 'Support desk',
  brand: 'HandsFreeOS',
  noSubject: '(no subject)',
  nobodyYet: 'Nobody yet',
  nobody: 'Nobody',
  me: '(me)',
  searchTickets: 'Search by subject, address or #number',
  queueEmptyTitle: 'Nothing here.',
  queueEmptyUnanswered: 'Every ticket has been answered. That is the whole idea.',
  queueEmptyFiltered: 'No tickets match this.',
  olderTickets: 'Older tickets',
  allTickets: 'All tickets',
  internalNote: 'Internal note',
  internalNoteTag: ' · internal note',
  notePlaceholder: 'A note for whoever picks this up next. The customer never sees it.',
  replyPlaceholder: 'Write back. Plain words, and say what happens next.',
  sendReply: 'Send it',
  saveNote: 'Save the note',
  askAi: 'Ask the AI for a draft',
  draftTitle: 'A suggested answer',
  draftStale: 'written before their latest message',
  draftFrom: (titles: readonly string[]) => `From: ${titles.join(' · ')}`,
  draftNothingSolid:
    'It had nothing solid to go on, so read this as questions to ask rather than an answer.',
  draftUse: 'Put it in the box',
  draftDismiss: 'No thanks',
  replyGoesOut:
    'A reply goes out from support@handsfreeos.com, and their answer comes back to this ticket.',
  thisTicket: 'This ticket',
  status: 'Status',
  priority: 'Priority',
  whoHasIt: 'Who has it',
  cameIn: 'Came in',
  firstAnswered: 'First answered',
  notYet: 'Not yet',
  theirBusiness: 'Their business',
  businessUnknown:
    'We do not know which business this is about yet. Their address is not one of our users, or they work in more than one.',
  openAccountPage: 'Open their account page',
  alsoFromThem: 'Also from them',
  whatHappened: 'What happened',
  people: (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`,
  withUsSince: (date: string) => `with us since ${date}`,
} as const;
