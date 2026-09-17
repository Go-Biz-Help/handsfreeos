/**
 * The inbox's list, the same on the web and the phone (M10): the boxes (Mine, Unassigned, All, and the AI teammate's
 * two), what a row says (who, the latest message, when) and the chips under it (waiting, the teammate, a new number,
 * snoozed, closed), and what an empty list says. Browser-safe.
 */
import { minutesWaiting, waitingFor, zonedWhen } from './time';

/** Every inbox box, the teammate's two included. */
export type InboxBoxKey = 'mine' | 'unassigned' | 'all' | 'needs_person' | 'ai';
export const INBOX_BOXES: readonly InboxBoxKey[] = [
  'mine',
  'unassigned',
  'all',
  'needs_person',
  'ai',
];

export type ConversationStatus = 'open' | 'snoozed' | 'closed';
export const CONVERSATION_STATUSES: readonly ConversationStatus[] = ['open', 'snoozed', 'closed'];

export const STATUS_LABELS: Readonly<Record<ConversationStatus, string>> = {
  open: 'Open',
  snoozed: 'Snoozed',
  closed: 'Closed',
};

/** "Mine · 3". */
export function boxLabel(box: 'mine' | 'unassigned' | 'all', count: number): string {
  const name = box === 'mine' ? 'Mine' : box === 'unassigned' ? 'Unassigned' : 'All';
  return `${name} · ${count}`;
}

/** "Needs a person" and the teammate's own box, by its name. */
export const NEEDS_PERSON = 'Needs a person';

export const firstName = (full: string): string => full.trim().split(/\s+/)[0] || full;

/** What a row needs to know about its conversation. */
export interface RowFacts {
  readonly channel: 'sms' | 'email' | 'chat';
  readonly counterpartDisplay: string;
  readonly status: ConversationStatus;
  readonly person: { readonly id: string; readonly fullName: string } | null;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
  readonly lastPreview: string | null;
  readonly lastDirection: 'inbound' | 'outbound' | null;
  readonly lastSentBy: { readonly id: string; readonly fullName: string } | null;
  readonly awaitingReplySince: string | null;
  readonly snoozedUntil: string | null;
  readonly openLead: { readonly stageName: string } | null;
  readonly handledBy: 'none' | 'ai' | 'person';
  readonly teammate: { readonly name: string } | null;
  readonly needsPersonSince: string | null;
  readonly onSiteNow: boolean;
}

/** Who a row is: the customer, or the number, address or chat visitor nobody has linked. */
export const rowName = (c: Pick<RowFacts, 'person' | 'counterpartDisplay'>): string =>
  c.person?.fullName ?? c.counterpartDisplay;

/** "You: …" and "Marco: …" for what the business sent; the customer's words as they are. */
export function previewLine(
  c: Pick<RowFacts, 'lastMessageAt' | 'lastPreview' | 'lastDirection' | 'lastSentBy'>,
  myUserId: string,
): string {
  if (!c.lastMessageAt) return 'No messages yet';
  const text = c.lastPreview ?? '';
  if (c.lastDirection !== 'outbound' || !c.lastSentBy) return text;
  return `${c.lastSentBy.id === myUserId ? 'You' : firstName(c.lastSentBy.fullName)}: ${text}`;
}

/** One chip under a row, in the order the row shows them. */
export type RowChip =
  | { readonly kind: 'needs_person'; readonly label: string }
  | { readonly kind: 'wait'; readonly minutes: number; readonly label: string }
  | { readonly kind: 'ai'; readonly label: string }
  | { readonly kind: 'on_site'; readonly label: string }
  | { readonly kind: 'stage'; readonly label: string }
  | { readonly kind: 'new_number'; readonly label: string }
  | { readonly kind: 'snoozed'; readonly label: string }
  | { readonly kind: 'closed'; readonly label: string };

/**
 * What needs attention on a row: how long the customer has waited (amber once past the reminder threshold), the AI
 * teammate ("Ava", "Ava · draft waiting", or "Needs a person" with how long since), a chat visitor still on the site,
 * the open lead's stage, a number that isn't a customer yet, and snoozed or closed.
 */
export function conversationChips(
  c: RowFacts,
  opts: {
    /** Minutes a customer waits before the row says so (the business's reminder setting). */
    readonly waitThreshold: number;
    /** The teammate's reply waits for someone's OK. */
    readonly draftWaiting?: boolean;
    /** The business's time zone, for "Snoozed until 3:10 PM". */
    readonly timeZone: string;
    readonly now?: number;
    /**
     * How the teammate's chip names what it does: "Ava" on the web's narrow column, "Ava is handling" on the phone app
     * (its canvas). Either way a draft waiting reads "Ava · draft waiting".
     */
    readonly teammateChip?: 'name' | 'handling';
  },
): RowChip[] {
  const now = opts.now ?? Date.now();
  const chips: RowChip[] = [];
  const needsPerson = c.status === 'open' && !!c.needsPersonSince;
  const aiName = c.handledBy === 'ai' ? (c.teammate?.name ?? null) : null;
  const handedFor = needsPerson ? minutesWaiting(c.needsPersonSince, now) : null;
  const waited = c.status === 'open' ? minutesWaiting(c.awaitingReplySince, now) : null;
  const wait = (minutes: number): RowChip => ({
    kind: 'wait',
    minutes,
    label: waitingFor(minutes, { capital: true }),
  });
  if (needsPerson) {
    chips.push({ kind: 'needs_person', label: NEEDS_PERSON });
    if (handedFor !== null) chips.push(wait(handedFor));
  } else if (aiName)
    chips.push({
      kind: 'ai',
      label: opts.draftWaiting
        ? `${aiName} · draft waiting`
        : opts.teammateChip === 'handling'
          ? `${aiName} is handling`
          : aiName,
    });
  if (c.onSiteNow) chips.push({ kind: 'on_site', label: 'On the site now' });
  if (!needsPerson && waited !== null && waited >= opts.waitThreshold) chips.push(wait(waited));
  if (c.openLead) chips.push({ kind: 'stage', label: c.openLead.stageName });
  if (!c.person && c.channel !== 'chat') chips.push({ kind: 'new_number', label: 'New number' });
  if (c.status === 'snoozed' && c.snoozedUntil)
    chips.push({
      kind: 'snoozed',
      label: `Snoozed until ${zonedWhen(new Date(c.snoozedUntil), opts.timeZone, new Date(now))}`,
    });
  if (c.status === 'closed') chips.push({ kind: 'closed', label: 'Closed' });
  return chips;
}

/** "Assigned to Marco Diaz", for the assignee's avatar on a row. */
export const assignedToLabel = (fullName: string): string => `Assigned to ${fullName}`;

/** The unread count on a row: "99+" past 99. */
export const unreadLabel = (count: number): string => (count > 99 ? '99+' : String(count));

/** What an empty list says, for its box, status and search. */
export function inboxEmptyWords(
  box: InboxBoxKey,
  status: ConversationStatus,
  q: string,
  name: string,
): { title: string; body: string } {
  if (q)
    return {
      title: `Nothing matches “${q}”`,
      body: 'Try a name, a number or words from a message.',
    };
  if (box === 'needs_person')
    return {
      title: 'Nobody is waiting for a person',
      body: `Conversations ${name} hands to a person land here. They leave the box once someone replies.`,
    };
  if (box === 'ai')
    return {
      title: `${name} isn’t handling anything right now`,
      body: `Conversations ${name} answers show here, until someone takes one over.`,
    };
  if (status === 'snoozed')
    return { title: 'Nothing snoozed', body: 'Conversations you snooze or close show up here.' };
  if (status === 'closed')
    return { title: 'Nothing closed yet', body: 'Conversations you snooze or close show up here.' };
  return {
    title: box === 'mine' ? 'Nothing waiting on you' : 'All caught up',
    body: 'New texts, calls and emails land here as they arrive.',
  };
}
