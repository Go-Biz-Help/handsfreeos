import {
  deskSectionLabel,
  IDEA_SORT_WORDS,
  IDEA_TRIAGE_TABS,
  IDEAS_TEAM_WORDS,
  IDEAS_WORDS,
  ideaTriageCount,
  ideaTriageQuery,
  ideaTriageSummary,
  relativeTimeAgo,
  type IdeaSort,
  type IdeaTriageTab,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { desk, useLive, usePaged, type Ok } from '@/admin/live';
import {
  DeskWaiting,
  Empty,
  FilterChips,
  PickSheet,
  SearchBox,
  useSettled,
} from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { ChevronDown, ChevronUp, Layers, Megaphone } from '@/components/icons';
import { StatusPill } from '@/components/ideas/idea-bits';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { useColors } from '@/theme';

type Triage = Ok<'/v1/queries/idea.triage'>;
type TriageRow = Triage['ideas'][number];

const SORTS: readonly IdeaSort[] = ['top', 'trending', 'new'];

/**
 * Ideas, as the team reads the board (the web's /admin/ideas): "Under review" first, the ideas nobody here has
 * answered yet, with who shared each from which business and how many different businesses voted for it, which says
 * more than the vote count alone. Search, an area and the sort narrow it; What's new and, for leads and admins, the
 * areas are a press away at the top. Pull down for the latest.
 */
export default function DeskIdeas() {
  const colors = useColors();
  const canManage = useDeskCan('platform.ideas.manage');
  const [tab, setTab] = React.useState<IdeaTriageTab>('under_review');
  const [sort, setSort] = React.useState<IdeaSort>('top');
  const [areaId, setAreaId] = React.useState<string | null>(null);
  const [pickingArea, setPickingArea] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const search = useSettled(typed);
  const areas = useLive(() => desk('/v1/queries/idea.areas', {}), 'idea-areas');
  const names = new Map((areas.data?.areas ?? []).map((a) => [a.id, a.name]));

  const where = ideaTriageQuery(tab);
  const body = (cursor: string | null) => ({
    show: where.show,
    status: where.status,
    sort,
    ...(areaId ? { areaId } : {}),
    ...(search ? { search: search.slice(0, 200) } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const list = usePaged<Triage>(
    (cursor) => desk('/v1/queries/idea.triage', body(cursor)),
    (was, page) => ({
      ...page,
      ideas: [...was.ideas, ...page.ideas.filter((i) => !was.ideas.some((w) => w.id === i.id))],
    }),
    JSON.stringify({ tab, sort, areaId, search }),
  );

  // The counts come with each page; the last ones stay up while another tab is on its way.
  const counts = React.useRef<Triage['counts'] | null>(null);
  if (list.data) counts.current = list.data.counts;

  const refresh = () => {
    list.reload();
    areas.reload();
  };

  return (
    <Screen
      title={deskSectionLabel('ideas')}
      subtitle={counts.current ? ideaTriageSummary(counts.current) : undefined}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-ideas"
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <View className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1">
            <SearchBox
              value={typed}
              onChange={setTyped}
              placeholder={IDEAS_WORDS.search}
              testID="triage-search"
            />
          </View>
          <Pressable
            role="button"
            accessibilityLabel={`${IDEAS_WORDS.areaFilterLabel}. ${
              areaId ? (names.get(areaId) ?? areaId) : IDEAS_TEAM_WORDS.everyArea
            }`}
            onPress={() => setPickingArea(true)}
            className="h-11 max-w-[44%] flex-row items-center gap-1.5 rounded-menu border border-border-strong bg-card px-3 active:bg-card-2"
            testID="triage-area"
          >
            <Text className="flex-shrink text-[13px] font-medium" numberOfLines={1}>
              {areaId ? (names.get(areaId) ?? areaId) : IDEAS_TEAM_WORDS.everyArea}
            </Text>
            <Icon as={ChevronDown} className="size-4 text-text-3" />
          </Pressable>
        </View>
        <Segmented
          value={sort}
          onChange={setSort}
          label={IDEAS_TEAM_WORDS.sort}
          options={SORTS.map((v) => ({
            value: v,
            label: IDEA_SORT_WORDS[v],
            testID: `triage-sort-${v}`,
          }))}
        />
        <FilterChips
          options={IDEA_TRIAGE_TABS.map((t) => ({
            key: t.key,
            label: t.label,
            count: counts.current ? ideaTriageCount(t.key, counts.current) : null,
          }))}
          value={tab}
          onChange={setTab}
          testID="triage-tab"
        />
      </View>

      {list.data ? (
        <FlatList
          data={list.data.ideas}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => (
            <TriageRowView idea={item} area={names.get(item.areaId) ?? item.areaId} />
          )}
          contentContainerClassName="p-3 pb-8"
          ItemSeparatorComponent={() => <View className="h-2" />}
          keyboardShouldPersistTaps="handled"
          testID="triage-list"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={refresh}
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            <View className="mb-3">
              <List>
                <ListRow
                  icon={Megaphone}
                  label={IDEAS_WORDS.tabs.whatsNew}
                  onPress={() => router.push(deskHref('ideas/whats-new') as Href)}
                  testID="admin-whats-new"
                />
                {canManage ? (
                  <ListRow
                    icon={Layers}
                    label={IDEAS_TEAM_WORDS.areas}
                    onPress={() => router.push(deskHref('ideas/areas') as Href)}
                    testID="admin-idea-areas"
                  />
                ) : null}
              </List>
            </View>
          }
          ListEmptyComponent={
            <Empty
              title={IDEAS_TEAM_WORDS.emptyTitle}
              body={
                tab === 'under_review'
                  ? IDEAS_TEAM_WORDS.emptyUnderReview
                  : IDEAS_TEAM_WORDS.emptyFiltered
              }
              testID="triage-empty"
            />
          }
          ListFooterComponent={
            list.hasMore ? (
              <Button
                variant="secondary"
                className="mt-4"
                loading={list.loadingMore}
                onPress={list.more}
                testID="triage-more"
              >
                {IDEAS_WORDS.showMore}
              </Button>
            ) : null
          }
        />
      ) : (
        <DeskWaiting live={list} testID="triage" />
      )}

      <PickSheet<string>
        open={pickingArea}
        onClose={() => setPickingArea(false)}
        title={IDEAS_WORDS.areaFilterLabel}
        value={areaId ?? ''}
        options={[
          { value: '', label: IDEAS_TEAM_WORDS.everyArea },
          ...(areas.data?.areas ?? []).map((a) => ({ value: a.id, label: a.name })),
        ]}
        onPick={(id) => setAreaId(id || null)}
        testID="pick-area"
      />
    </Screen>
  );
}

/** One idea in the list: its votes, where it stands, how many businesses want it, and who shared it from where. */
function TriageRowView({ idea: i, area }: { idea: TriageRow; area: string }) {
  return (
    <Pressable
      role="button"
      onPress={() => router.push(deskHref(`ideas/${i.id}`) as Href)}
      testID={`triage-row-${i.number}`}
      className="flex-row gap-3 rounded-card border border-border bg-card px-3.5 py-3 active:bg-card-2"
    >
      <View className="w-12 items-center self-start rounded-control border border-border py-1.5">
        <Icon as={ChevronUp} className="size-4 text-text-3" />
        <Text className="text-sm font-semibold tabular-nums">{String(i.voteCount)}</Text>
      </View>
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-baseline gap-2">
          <Text className="text-xs tabular-nums text-text-3">#{i.number}</Text>
          <Text className="min-w-0 flex-1 text-[15px] font-semibold" numberOfLines={2}>
            {i.title}
          </Text>
        </View>
        <View className="flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <StatusPill status={i.status} />
          <Text className="text-[13px] text-text-3">
            {[
              area,
              IDEAS_TEAM_WORDS.businesses(i.businessCount),
              i.commentCount ? IDEAS_TEAM_WORDS.commentCount(i.commentCount) : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {i.hidden ? (
            <Badge variant="pending">
              <Text>{IDEAS_TEAM_WORDS.takenDown}</Text>
            </Badge>
          ) : null}
          {i.mergedInto ? (
            <Text className="text-[13px] text-text-3">
              {IDEAS_TEAM_WORDS.mergedIntoNumber(i.mergedInto.number)}
            </Text>
          ) : null}
        </View>
        <Text className="text-[13px] text-text-2" numberOfLines={1}>
          {i.author ? i.author.name || i.author.email : IDEAS_TEAM_WORDS.someoneWhoLeft}
          {i.business ? ` · ${i.business.name}` : ''} · {relativeTimeAgo(i.createdAt)}
        </Text>
      </View>
    </Pressable>
  );
}
