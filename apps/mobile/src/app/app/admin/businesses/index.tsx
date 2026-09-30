import {
  DESK_BUSINESS_SORTS,
  DESK_BUSINESS_WORDS,
  deskBusinessSort,
  deskBusinessTotals,
  deskSectionLabel,
  type DeskBusinessSort,
} from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { desk, usePaged, type Ok } from '@/admin/live';
import {
  DeskWaiting,
  Empty,
  FilterChips,
  SearchBox,
  Stats,
  useSettled,
} from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useColors } from '@/theme';

type BusinessList = Ok<'/v1/queries/platform.business.list'>;
type BusinessRow = BusinessList['businesses'][number];

const PAGE = 25;

/**
 * Every business on HandsFreeOS (the web's /admin/businesses): the three numbers looked at daily, then the directory,
 * searched by business or agency name and put in one of four orders. Only Newest pages, as on the web: it is the one
 * order that can't change under the reader's feet. A row opens the business.
 */
export default function Businesses() {
  const canRead = useDeskCan('platform.businesses.read');
  if (!canRead)
    return (
      <Screen
        title={deskSectionLabel('businesses')}
        leading="back"
        back={deskHref()}
        testID="desk-businesses"
      >
        <Empty
          title={DESK_BUSINESS_PHONE_WORDS.notYourRole('businesses')}
          testID="businesses-not-yours"
        />
      </Screen>
    );
  return <Directory />;
}

function Directory() {
  const colors = useColors();
  // Newest and everything, unless a link to the web's page asked for an order or a search (?sort=quietest&q=bayou).
  const linked = useLocalSearchParams<{ sort?: string; q?: string }>();
  const [sort, setSort] = React.useState<DeskBusinessSort>(() => deskBusinessSort(linked.sort));
  const [typed, setTyped] = React.useState(linked.q ?? '');
  const search = useSettled(typed);

  const list = usePaged<BusinessList>(
    (cursor) =>
      desk('/v1/queries/platform.business.list', {
        ...(search ? { search } : {}),
        sort,
        ...(cursor ? { cursor } : {}),
        limit: PAGE,
      }),
    (was, page) => ({
      businesses: [
        ...was.businesses,
        ...page.businesses.filter(
          (b) => !was.businesses.some((w) => w.workspaceId === b.workspaceId),
        ),
      ],
      nextCursor: page.nextCursor,
      totals: page.totals,
    }),
    JSON.stringify({ sort, search }),
  );

  return (
    <Screen
      title={deskSectionLabel('businesses')}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-businesses"
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <SearchBox
          value={typed}
          onChange={setTyped}
          placeholder={DESK_BUSINESS_WORDS.searchPlaceholder}
          testID="business-search"
        />
        <FilterChips
          options={DESK_BUSINESS_SORTS}
          value={sort}
          onChange={setSort}
          testID="business-sort"
        />
      </View>

      {list.data ? (
        <FlatList
          data={list.data.businesses}
          keyExtractor={(b) => b.workspaceId}
          renderItem={({ item }) => <BusinessRowView business={item} />}
          contentContainerClassName="p-3 pb-8"
          ItemSeparatorComponent={() => <View className="h-2" />}
          keyboardShouldPersistTaps="handled"
          testID="business-list"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={list.reload}
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            <View className="pb-3">
              <Stats items={deskBusinessTotals(list.data.totals)} testID="business-totals" />
            </View>
          }
          ListEmptyComponent={
            <Empty title={DESK_BUSINESS_WORDS.nothingMatches} testID="businesses-empty" />
          }
          ListFooterComponent={
            list.hasMore ? (
              <Button
                variant="secondary"
                className="mt-4"
                loading={list.loadingMore}
                onPress={list.more}
                testID="businesses-more"
              >
                {DESK_BUSINESS_WORDS.more}
              </Button>
            ) : null
          }
        />
      ) : (
        <DeskWaiting live={list} testID="businesses" />
      )}
    </Screen>
  );
}

function BusinessRowView({ business: b }: { business: BusinessRow }) {
  return (
    <Pressable
      role="button"
      onPress={() => router.push(deskHref(`businesses/${b.workspaceId}`) as Href)}
      testID={`business-row-${b.workspaceId}`}
      className="gap-1 rounded-card border border-border bg-card px-4 py-3 active:bg-card-2"
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-[15px] font-semibold" numberOfLines={1}>
          {b.name}
        </Text>
        {b.openTicketCount > 0 ? (
          <Badge variant="accent" testID={`business-open-${b.workspaceId}`}>
            {DESK_BUSINESS_WORDS.openTickets(b.openTicketCount)}
          </Badge>
        ) : null}
      </View>
      <Text className="text-[13px] text-text-3" numberOfLines={1}>
        {DESK_BUSINESS_WORDS.people(b.memberCount)} ·{' '}
        {DESK_BUSINESS_WORDS.lastActive(b.lastActiveAt)}
      </Text>
    </Pressable>
  );
}
