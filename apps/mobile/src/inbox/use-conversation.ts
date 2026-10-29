import {
  canTextOf,
  conversationOf,
  customerFirstName,
  formatPhone,
  quietHoursState,
  threadItemsOf,
  type CallThreadRow,
  type CanText,
  type ConversationListRow,
  type ConversationShape,
  type MessageThreadRow,
  type QuietFacts,
  type ThreadItemShape,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import { useNetwork } from '@/lib/network';
import { seesThread } from '@/view-as/state';
import { useLens } from '@/view-as/use-lens';

import { useConversationNumber, type BusinessNumber } from './cell';
import {
  cancelledHere,
  movedPersonOf,
  pendingReplies,
  withMovedHere,
  withOwnChanges,
  type PendingReply,
} from './outbox';
import {
  CALLS_SQL,
  CONVERSATION_SQL,
  MESSAGES_SQL,
  NOTES_SQL,
  OPTED_OUT_SQL,
  PERSON_SQL,
} from './queries';
import { noteOf, type NoteEntry, type NoteRow } from './thread-entries';
import {
  useBusinessSettings,
  useInboxOutbox,
  useMembers,
  useMovedHere,
  useNow,
  useTeammate,
  type Teammate,
} from './use-inbox';

/**
 * One conversation from the phone's copy, as the web's `conversation.get` and `conversation.thread` give it: the
 * conversation with this phone's own changes over it, its customer, whether a text can go now and quiet hours, and its
 * thread (without what phones hide) with the replies written here that haven't arrived back yet.
 */

export interface ConversationPerson {
  readonly id: string;
  readonly fullName: string;
  /** The two halves behind `fullName`, which the edit sheet's fields and the merge base both want. */
  readonly firstName: string;
  readonly lastName: string;
  /** "(713) 555-0142". */
  readonly phone: string | null;
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly smsConsent: string | null;
  readonly customerSince: string;
  readonly archived: boolean;
  /** What the edit sheet opens with, beyond the name and the ways to reach them. */
  readonly line1: string;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly notes: string;
}

export interface ConversationData {
  readonly conversation: ConversationShape;
  readonly draftWaiting: boolean;
  readonly person: ConversationPerson | null;
  /** "Mike", or null for a number nobody has linked. */
  readonly first: string | null;
  readonly canText: CanText;
  /** The business's number, "(713) 555-0100". */
  readonly fromNumber: string | null;
  readonly number: BusinessNumber | null;
  readonly quiet: QuietFacts;
  readonly timeZone: string;
  readonly teammate: Teammate | null;
  /** When the customer last wrote: how long Messenger and Instagram let the business answer runs from it. */
  readonly lastInboundAt: string | null;
}

type ListRow = ConversationListRow & {
  readonly draft_waiting: number | null;
  readonly last_inbound_at?: string | null;
};

export function useConversation(conversationId: string): {
  readonly data: ConversationData | null;
  readonly loading: boolean;
} {
  const { business, me } = useBusiness();
  const { data: rows, isLoading } = useQuery<ListRow>(CONVERSATION_SQL, [
    business.id,
    conversationId,
  ]);
  // Viewing as a teammate (20261018000100), a thread they don't see isn't here.
  const lens = useLens();
  const row = rows[0] && seesThread(lens, rows[0], me.user.id) ? rows[0] : undefined;
  const { data: people } = useQuery<{
    id: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    phone_e164: string | null;
    email: string | null;
    sms_consent: string | null;
    archived_at: string | null;
    created_at: string | null;
    address_line1: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    notes: string | null;
  }>(PERSON_SQL, [row?.person_id ?? movedPersonOf(conversationId) ?? '']);
  const { data: optOuts } = useQuery<{ opted_out: number | null }>(OPTED_OUT_SQL, [
    business.id,
    row?.channel === 'sms' ? row.counterpart : '',
  ]);
  const outbox = useInboxOutbox();
  const members = useMembers();
  const number = useConversationNumber(business.id, conversationId);
  const { timeZone, telephony } = useBusinessSettings();
  const teammate = useTeammate();
  const now = useNow();
  const moved = useMovedHere();

  const data = React.useMemo<ConversationData | null>(() => {
    void moved; // Only says to work it out again.
    if (!row) return null;
    const names = new Map(members.map((m) => [m.id, m.fullName]));
    const self = { id: me.user.id, fullName: me.user.fullName || me.user.email };
    const conversation = withMovedHere(withOwnChanges(conversationOf(row), outbox, self, names));
    const p = people[0];
    const person: ConversationPerson | null = p
      ? {
          id: p.id,
          fullName: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
          firstName: p.first_name ?? '',
          lastName: p.last_name ?? '',
          phone: p.phone_e164 ? formatPhone(p.phone_e164) : (p.phone ?? null),
          phoneE164: p.phone_e164,
          email: p.email,
          smsConsent: p.sms_consent,
          customerSince: p.created_at ?? conversation.createdAt,
          archived: !!p.archived_at,
          line1: p.address_line1 ?? '',
          city: p.city ?? '',
          state: p.state ?? '',
          postalCode: p.postal_code ?? '',
          notes: p.notes ?? '',
        }
      : null;
    return {
      conversation,
      draftWaiting: Number(row.draft_waiting ?? 0) > 0,
      person,
      first: customerFirstName(person),
      canText: canTextOf({
        channel: conversation.channel,
        hasActiveNumber: !!number?.active,
        optedOut: Number(optOuts[0]?.opted_out ?? 0) === 1,
        personSmsConsent: person?.smsConsent ?? null,
      }),
      fromNumber: number ? formatPhone(number.e164) : null,
      number,
      quiet: quietHoursState(telephony.quietHours, timeZone, new Date(now)),
      timeZone,
      teammate,
      lastInboundAt: row.last_inbound_at ?? null,
    };
  }, [
    row,
    people,
    optOuts,
    outbox,
    members,
    number,
    telephony,
    timeZone,
    teammate,
    now,
    me.user,
    moved,
  ]);
  return { data, loading: isLoading };
}

export interface ThreadData {
  readonly items: readonly ThreadItemShape[];
  readonly notes: readonly NoteEntry[];
  readonly pending: readonly PendingReply[];
}

/**
 * The thread: messages and calls oldest first, and the replies written on this phone still on their way. `laneIds`,
 * for "All lines", weaves in every lane of the customer rather than the one conversation (0089).
 */
export function useThread(
  conversationId: string,
  personId: string | null,
  laneIds?: readonly string[],
): ThreadData {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const ids = JSON.stringify(laneIds?.length ? laneIds : [conversationId]);
  const { data: messages } = useQuery<MessageThreadRow>(MESSAGES_SQL, [business.id, ids]);
  const { data: calls } = useQuery<CallThreadRow>(CALLS_SQL, [business.id, ids]);
  const { data: noteRows } = useQuery<NoteRow>(NOTES_SQL, [business.id, personId ?? '']);
  const outbox = useInboxOutbox();
  const now = useNow(15_000);
  return React.useMemo(() => {
    const cancelled = cancelledHere(outbox);
    const items = threadItemsOf(messages, calls).filter(
      (i) => !(i.scheduledFor && cancelled.has(i.id)),
    );
    const arrived = new Set(items.flatMap((i) => (i.clientId ? [i.clientId] : [])));
    const pending = (JSON.parse(ids) as string[])
      .flatMap((id) => pendingReplies(outbox, id, arrived, online, now))
      .sort((a, b) => a.row.seq - b.row.seq);
    return { items, notes: personId ? noteRows.map(noteOf) : [], pending };
  }, [messages, calls, noteRows, personId, outbox, ids, online, now]);
}
