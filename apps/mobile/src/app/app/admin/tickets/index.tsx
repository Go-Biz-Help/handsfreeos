import {
  deskSectionLabel,
  DESK_WORDS,
  sinceIso,
  TICKET_QUEUE_FILTERS,
  TICKET_PRIORITY_WORDS,
  TICKET_QUEUE_QUERIES,
  TICKET_STATUS_WORDS,
  ticketQueueCount,
  ticketQueueSummary,
  type TicketQueueFilter,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { desk, useLive, usePaged, useReloadOnReturn, type Ok } from '@/admin/live';
import { DeskWaiting, Empty, FilterChips, SearchBox, useSettled } from '@/components/admin/bits';
import { deskHref } from '@/components/admin/staff-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type TicketList = Ok<'/v1/queries/support.ticket.list'>;
type TicketRow = TicketList['tickets'][number];

const PAGE = 25;

/**
 * Tickets, the queue (the web's /admin/tickets): "Needs an answer" first, since it is the one that matters, and the
 * other tabs for looking things up. Search is by subject, address or #number. Pull down for the latest.
 */
export default function Tickets() {
  const colors = useColors();
  const [filter, setFilter] = React.useState<TicketQueueFilter>('unanswered');
  const [typed, setTyped] = React.useState('');
  const search = useSettled(typed);
  const counts = useLive(() => desk('/v1/queries/support.queue.summary', {}), 'queue-summary');

  const where = TICKET_QUEUE_QUERIES[filter];
  const body = (cursor: string | null) => ({
    ...(where.status ? { status: [...where.status] } : {}),
    assignee: where.assignee,
    ...(search ? { search } : {}),
    ...(cursor ? { cursor } : {}),
    limit: PAGE,
  });
  const list = usePaged<TicketList>(
    (cursor) => desk('/v1/queries/support.ticket.list', body(cursor)),
    (was, page) => ({
      tickets: [
        ...was.tickets,
        ...page.tickets.filter((t) => !was.tickets.some((w) => w.id === t.id)),
      ],
      nextCursor: page.nextCursor,
    }),
    JSON.stringify({ filter, search }),
  );

  const refresh = () => {
    list.reload();
    counts.reload();
  };
  useReloadOnReturn(list.reload, counts.reload);

  return (
    <Screen
      title={deskSectionLabel('tickets')}
      subtitle={counts.data ? ticketQueueSummary(counts.data) : undefined}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-tickets"
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <SearchBox
          value={typed}
          onChange={setTyped}
          placeholder={DESK_WORDS.searchTickets}
          testID="ticket-search"
        />
        <FilterChips
          options={TICKET_QUEUE_FILTERS.map((f) => ({
            key: f.key,
            label: f.label,
            count: counts.data ? ticketQueueCount(f.key, counts.data) : null,
          }))}
          value={filter}
          onChange={setFilter}
          testID="queue-filter"
        />
      </View>

      {list.data ? (
        <FlatList
          data={list.data.tickets}
          keyExtractor={(t) => t.id}
          renderItem={({ item }) => <TicketRowView ticket={item} />}
          contentContainerClassName="p-3 pb-8"
          ItemSeparatorComponent={() => <View className="h-2" />}
          keyboardShouldPersistTaps="handled"
          testID="ticket-list"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={refresh}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <Empty
              title={DESK_WORDS.queueEmptyTitle}
              body={
                filter === 'unanswered' && !search
                  ? DESK_WORDS.queueEmptyUnanswered
                  : DESK_WORDS.queueEmptyFiltered
              }
              testID="queue-empty"
            />
          }
          ListFooterComponent={
            list.hasMore ? (
              <Button
                variant="secondary"
                className="mt-4"
                loading={list.loadingMore}
                onPress={list.more}
                testID="tickets-more"
              >
                {DESK_WORDS.olderTickets}
              </Button>
            ) : null
          }
        />
      ) : (
        <DeskWaiting live={list} testID="tickets" />
      )}
    </Screen>
  );
}

function TicketRowView({ ticket: t }: { ticket: TicketRow }) {
  const loud = t.priority === 'urgent' || t.priority === 'high';
  return (
    <Pressable
      role="button"
      onPress={() => router.push(deskHref(`tickets/${t.id}`) as Href)}
      testID={`ticket-row-${t.number}`}
      className="gap-1 rounded-card border border-border bg-card px-4 py-3 active:bg-card-2"
    >
      <View className="flex-row items-baseline gap-2">
        <Text className="text-xs tabular-nums text-text-3">#{t.number}</Text>
        <Text className="min-w-0 flex-1 text-[15px] font-semibold" numberOfLines={1}>
          {t.subject || DESK_WORDS.noSubject}
        </Text>
        <Text className="text-xs text-text-3">{sinceIso(t.updatedAt)}</Text>
      </View>
      <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
        <Text className="text-[13px] text-text-3" numberOfLines={1}>
          {[t.requester.name || t.requester.email, t.business?.name, TICKET_STATUS_WORDS[t.status]]
            .filter(Boolean)
            .join(' · ')}
        </Text>
        {loud ? (
          <View className="rounded-full bg-danger-soft px-2 py-0.5">
            <Text className="text-[11px] font-medium text-danger-text">
              {TICKET_PRIORITY_WORDS[t.priority]}
            </Text>
          </View>
        ) : null}
        <Text
          className={cn('ml-auto text-[13px]', t.assignee ? 'text-text-3' : 'text-accent-text')}
          numberOfLines={1}
        >
          {t.assignee ? t.assignee.name : DESK_WORDS.nobodyYet}
        </Text>
      </View>
      <Text className="text-[13px] text-text-2" numberOfLines={2}>
        {t.preview}
      </Text>
    </Pressable>
  );
}
