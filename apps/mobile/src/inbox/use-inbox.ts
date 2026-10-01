import {
  conversationOf,
  groupByCustomer,
  inboxCounts,
  inboxOrder,
  lanesOf,
  telephonySettingsOf,
  type ConversationListRow,
  type ConversationShape,
  type InboxCounts,
  type InboxFilter,
  type InboxLane,
  type TeammateStatus,
} from '@hfos/core';
import { useQuery } from '@powersync/react-native';
import * as React from 'react';

import { useBusiness } from '@/components/shell/business-context';
import type { OutboxRow } from '@/changes/outbox';
import { SENT_SHOWN_MS } from '@/changes/rules';

import { seesThread } from '@/view-as/state';
import { useLens } from '@/view-as/use-lens';

import { movedHereVersion, subscribeMovedHere, withMovedHere, withOwnChanges } from './outbox';
import {
  CONVERSATIONS_SQL,
  INBOX_OUTBOX_SQL,
  LANES_SQL,
  MEMBERS_SQL,
  OWN_ADDRESS_SQL,
  TEAMMATE_SQL,
  WORKSPACE_SQL,
} from './queries';

/**
 * The inbox from the phone's copy: every conversation in the business on screen (its open ones and the last 12 months'
 * messages are on the phone), the team's and the person's own mail (M19), with this phone's own changes over them,
 * filtered, grouped into one row per customer, ordered and counted as the web's `inbox.list` and `inbox.summary` do
 * (core's `groupByCustomer`, `inboxOrder`, `inboxCounts`).
 */

type ListRow = ConversationListRow & { readonly draft_waiting: number | null };

export interface InboxItem {
  readonly conversation: ConversationShape;
  /** The AI teammate's reply waits for someone's OK. */
  readonly draftWaiting: boolean;
}

export interface Teammate {
  readonly id: string;
  readonly name: string;
  readonly status: TeammateStatus;
}

/** Now, moved on every 30 seconds: waiting times and snoozes read it. */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** The inbox's changes on this phone for the business on screen, not through or sent just now. */
export function useInboxOutbox(): readonly OutboxRow[] {
  const { business } = useBusiness();
  const since = React.useMemo(() => new Date(Date.now() - SENT_SHOWN_MS).toISOString(), []);
  const { data } = useQuery<OutboxRow>(INBOX_OUTBOX_SQL, [business.id, since]);
  return data;
}

/** Who a conversation can be assigned to, by name. */
export function useMembers(): readonly { readonly id: string; readonly fullName: string }[] {
  const { business } = useBusiness();
  const { data } = useQuery<{ id: string; full_name: string | null }>(MEMBERS_SQL, [
    business.id,
    business.id,
  ]);
  return React.useMemo(() => data.map((m) => ({ id: m.id, fullName: m.full_name ?? '' })), [data]);
}

/** The business's AI teammate, or null when it has none. */
export function useTeammate(): Teammate | null {
  const { business } = useBusiness();
  const { data } = useQuery<{ id: string; name: string; status: string }>(TEAMMATE_SQL, [
    business.id,
  ]);
  const row = data[0];
  return React.useMemo(
    () =>
      row
        ? {
            id: row.id,
            name: row.name,
            status: (row.status === 'automatic' || row.status === 'off'
              ? row.status
              : 'training') as TeammateStatus,
          }
        : null,
    [row],
  );
}

/** The business's time zone and texting settings. */
export function useBusinessSettings() {
  const { business } = useBusiness();
  const { data } = useQuery<{ name: string; timezone: string | null; settings: string | null }>(
    WORKSPACE_SQL,
    [business.id],
  );
  const row = data[0];
  return React.useMemo(
    () => ({
      timeZone: row?.timezone || business.timezone,
      settings: row?.settings ?? null,
      telephony: telephonySettingsOf(row?.settings ?? null),
    }),
    [row, business.timezone],
  );
}

/** Re-renders when an email thread is moved or shared on this phone (M19); the number is only compared. */
export function useMovedHere(): number {
  return React.useSyncExternalStore(subscribeMovedHere, movedHereVersion);
}

/** Every conversation in the business, the person's own mail among them, with this phone's own changes over each. */
export function useConversations(): {
  readonly items: readonly InboxItem[];
  readonly loading: boolean;
} {
  const { business, me } = useBusiness();
  const { data, isLoading } = useQuery<ListRow>(CONVERSATIONS_SQL, [business.id, me.user.id]);
  const outbox = useInboxOutbox();
  const members = useMembers();
  const moved = useMovedHere();
  // Viewing as a teammate (20261016000200): only the threads they see.
  const lens = useLens();
  return React.useMemo(() => {
    void moved; // Only says to work it out again.
    const names = new Map(members.map((m) => [m.id, m.fullName]));
    const self = { id: me.user.id, fullName: me.user.fullName || me.user.email };
    return {
      items: data
        .filter((row) => seesThread(lens, row, me.user.id))
        .map((row) => ({
          conversation: withMovedHere(withOwnChanges(conversationOf(row), outbox, self, names)),
          draftWaiting: Number(row.draft_waiting ?? 0) > 0,
        })),
      loading: isLoading,
    };
  }, [data, outbox, members, me.user.id, me.user.fullName, me.user.email, isLoading, moved, lens]);
}

/** Whether the person has an address of their own here (M19), so My mail shows before any mail has come to it. */
export function useOwnAddress(): boolean {
  const { business, me } = useBusiness();
  const { data } = useQuery<{ own: number | null }>(OWN_ADDRESS_SQL, [business.id, me.user.id]);
  return Number(data[0]?.own ?? 0) > 0;
}

/**
 * The list for a box, status and search, the team's or the person's own mail, one row per customer, in the web's order,
 * and every box's counts.
 */
export function useInboxList(filter: InboxFilter): {
  readonly items: readonly InboxItem[];
  readonly counts: InboxCounts;
  readonly loading: boolean;
} {
  const { me } = useBusiness();
  const { items, loading } = useConversations();
  const { telephony } = useBusinessSettings();
  const ownAddress = useOwnAddress();
  const now = useNow();
  return React.useMemo(() => {
    const all = items.map((i) => i.conversation);
    const order = inboxOrder(filter.box);
    return {
      items: groupByCustomer(items, filter, me.user.id).sort((a, b) =>
        order(a.conversation, b.conversation),
      ),
      counts: inboxCounts(all, me.user.id, telephony.unansweredReminderMinutes, now, ownAddress),
      loading,
    };
  }, [items, filter, me.user.id, telephony.unansweredReminderMinutes, now, ownAddress, loading]);
}

/**
 * Every live lane of the customer behind one conversation, newest first, with this phone's own changes over each
 * (0089): what the thread's line switcher lists. Empty until the conversation has loaded.
 */
export function useLanes(
  c: Pick<ConversationShape, 'id' | 'person' | 'channel' | 'counterpart'> | null,
): readonly InboxLane[] {
  const { business, me } = useBusiness();
  const personId = c?.person?.id ?? '';
  const { data } = useQuery<ListRow>(LANES_SQL, [
    business.id,
    c?.id ?? '',
    personId,
    personId,
    personId,
    c?.channel ?? '',
    c?.counterpart ?? '',
  ]);
  const outbox = useInboxOutbox();
  const lens = useLens();
  return React.useMemo(() => {
    if (!c) return [];
    const self = { id: me.user.id, fullName: me.user.fullName || me.user.email };
    return lanesOf(
      data
        .filter((row) => seesThread(lens, row, me.user.id))
        .map((row) => withOwnChanges(conversationOf(row), outbox, self)),
    );
  }, [c, data, outbox, me.user.id, me.user.fullName, me.user.email, lens]);
}
