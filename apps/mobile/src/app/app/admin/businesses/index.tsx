import {
  DESK_BUSINESS_SORTS,
  DESK_BUSINESS_WORDS,
  DESK_PLAN_WORDS,
  deskBusinessSort,
  deskBusinessTotals,
  deskSectionLabel,
  type DeskBusinessSort,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
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
import { BusinessQuickLook } from '@/components/admin/business-quick-look';
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
 * searched by business or agency name and put in one of its orders. Only Newest and Needs a look page, as on the web:
 * they go by sign-up, the one order that can't change under the reader's feet. A row opens the business's quick look,
 * and its own screen is a button away from there.
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
  const [looking, setLooking] = React.useState<string | null>(null);

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
          renderItem={({ item }) => (
            <BusinessRowView business={item} onPress={() => setLooking(item.workspaceId)} />
          )}
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

      <BusinessQuickLook
        rows={list.data?.businesses ?? []}
        openId={looking}
        onOpen={setLooking}
        onClose={() => setLooking(null)}
      />
    </Screen>
  );
}

function BusinessRowView({ business: b, onPress }: { business: BusinessRow; onPress: () => void }) {
  return (
    <Pressable
      role="button"
      onPress={onPress}
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
      {b.attention.length || b.plan || b.foundingSeat ? (
        <View className="flex-row flex-wrap gap-1.5 pt-0.5">
          {b.attention.length ? (
            <Badge variant="pending" testID={`business-needs-look-${b.workspaceId}`}>
              {DESK_BUSINESS_WORDS.needsALook}
            </Badge>
          ) : null}
          {b.foundingSeat ? (
            <Badge variant="ok">{b.foundingSeat}</Badge>
          ) : b.plan ? (
            <Badge variant="gray" testID={`business-plan-${b.workspaceId}`}>
              {DESK_PLAN_WORDS[b.plan]}
            </Badge>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}
