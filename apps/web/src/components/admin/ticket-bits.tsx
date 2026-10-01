/**
 * The small shared pieces of the support desk: the shapes it passes around, and its words, which are core's so the
 * phone's Support desk says the same.
 */

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

export {
  TICKET_CHANNEL_WORDS as CHANNEL_WORD,
  TICKET_PRIORITY_WORDS as PRIORITY_WORD,
  TICKET_STATUS_WORDS as STATUS_WORD,
  sinceWords,
} from '@hfos/core';

/** A full date and time, in the reader's own zone. */
export const whenWords = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
