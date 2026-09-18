/** The small shared pieces of the support desk: the words it uses, and the shapes it passes around. */

export interface TicketPerson {
  readonly userId: string | null;
  readonly name: string;
  readonly email: string;
}

export interface TicketRow {
  readonly id: string;
  readonly number: number;
  readonly subject: string;
  readonly status: 'new' | 'open' | 'waiting_on_customer' | 'solved' | 'closed';
  readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  readonly channel: 'email' | 'in_app' | 'chat';
  readonly requester: TicketPerson;
  readonly business: { readonly workspaceId: string; readonly name: string } | null;
  readonly assignee: TicketPerson | null;
  readonly tags: readonly string[];
  readonly preview: string;
  readonly waitingSince: string | null;
  readonly snoozeUntil: string | null;
  readonly firstResponseAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const STATUS_WORD: Record<TicketRow['status'], string> = {
  new: 'New',
  open: 'Open',
  waiting_on_customer: 'Waiting on them',
  solved: 'Solved',
  closed: 'Closed',
};

export const CHANNEL_WORD: Record<TicketRow['channel'], string> = {
  email: 'By email',
  in_app: 'From inside the app',
  chat: 'From the website chat',
};

export const PRIORITY_WORD: Record<TicketRow['priority'], string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

/** "4 minutes", "3 hours", "2 days" — how long, said the way a person would say it. */
export function sinceWords(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** A full date and time, in the reader's own zone. */
export const whenWords = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
