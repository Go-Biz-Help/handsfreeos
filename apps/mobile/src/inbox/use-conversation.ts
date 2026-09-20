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

import { useConversationNumber, type BusinessNumber } from './cell';
import { cancelledHere, pendingReplies, withOwnChanges, type PendingReply } from './outbox';
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
  /** "(713) 555-0142". */
  readonly phone: string | null;
  readonly phoneE164: string | null;
  readonly email: string | null;
  readonly smsConsent: string | null;
  readonly customerSince: string;
  readonly archived: boolean;
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
}

type ListRow = ConversationListRow & { readonly draft_waiting: number | null };

export function useConversation(conversationId: string): {
  readonly data: ConversationData | null;
  readonly loading: boolean;
} {
  const { business, me } = useBusiness();
  const { data: rows, isLoading } = useQuery<ListRow>(CONVERSATION_SQL, [
    business.id,
    conversationId,
  ]);
  const row = rows[0];
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
  }>(PERSON_SQL, [row?.person_id ?? '']);
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

  const data = React.useMemo<ConversationData | null>(() => {
    if (!row) return null;
    const names = new Map(members.map((m) => [m.id, m.fullName]));
    const self = { id: me.user.id, fullName: me.user.fullName || me.user.email };
    const conversation = withOwnChanges(conversationOf(row), outbox, self, names);
    const p = people[0];
    const person: ConversationPerson | null = p
      ? {
          id: p.id,
          fullName: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(),
          phone: p.phone_e164 ? formatPhone(p.phone_e164) : (p.phone ?? null),
          phoneE164: p.phone_e164,
          email: p.email,
          smsConsent: p.sms_consent,
          customerSince: p.created_at ?? conversation.createdAt,
          archived: !!p.archived_at,
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
    };
  }, [row, people, optOuts, outbox, members, number, telephony, timeZone, teammate, now, me.user]);
  return { data, loading: isLoading };
}

export interface ThreadData {
  readonly items: readonly ThreadItemShape[];
  readonly notes: readonly NoteEntry[];
  readonly pending: readonly PendingReply[];
}

/** The thread: messages and calls oldest first, and the replies written on this phone still on their way. */
export function useThread(conversationId: string, personId: string | null): ThreadData {
  const { business } = useBusiness();
  const { online } = useNetwork();
  const { data: messages } = useQuery<MessageThreadRow>(MESSAGES_SQL, [
    business.id,
    conversationId,
  ]);
  const { data: calls } = useQuery<CallThreadRow>(CALLS_SQL, [business.id, conversationId]);
  const { data: noteRows } = useQuery<NoteRow>(NOTES_SQL, [business.id, personId ?? '']);
  const outbox = useInboxOutbox();
  const now = useNow(15_000);
  return React.useMemo(() => {
    const cancelled = cancelledHere(outbox);
    const items = threadItemsOf(messages, calls).filter(
      (i) => !(i.scheduledFor && cancelled.has(i.id)),
    );
    const arrived = new Set(items.flatMap((i) => (i.clientId ? [i.clientId] : [])));
    return {
      items,
      notes: personId ? noteRows.map(noteOf) : [],
      pending: pendingReplies(outbox, conversationId, arrived, online, now),
    };
  }, [messages, calls, noteRows, personId, outbox, conversationId, online, now]);
}
