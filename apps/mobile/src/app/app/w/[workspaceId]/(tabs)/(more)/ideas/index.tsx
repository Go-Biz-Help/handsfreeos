import {
  IDEA_SORT_WORDS,
  IDEA_SORTS,
  IDEAS_WORDS,
  relativeTimeAgo,
  votingOpenFor,
  type IdeaSort,
} from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { Lightbulb, MessageSquare, Plus, Search, SlidersHorizontal, X } from '@/components/icons';
import { IdeaFiltersSheet } from '@/components/ideas/filters-sheet';
import { IdeasLoading, IdeasNeedSignal, StatusPill } from '@/components/ideas/idea-bits';
import { IdeasTabs } from '@/components/ideas/ideas-tabs';
import { VoteButton } from '@/components/ideas/vote-button';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import {
  areaName,
  DEFAULT_FILTERS,
  isFiltered,
  useIdeaAreas,
  useIdeaBoard,
  type BoardFilters,
  type IdeaArea,
  type IdeaRow,
} from '@/ideas/use-ideas';
import { useColors } from '@/theme';

/**
 * Ideas, reached from More (0102): the board every business on HandsFreeOS shares, the ideas moving lately first.
 * A vote is one press on the row; the idea itself, its story and its comments are a press on its title. Search,
 * the sort and the web's three filters are here too, kept on the screen rather than in an address. It is live, as
 * the whole board is: with no signal it says so.
 */
export default function Ideas() {
  const { business } = useBusiness();
  const colors = useColors();
  const [filters, setFilters] = React.useState<BoardFilters>(DEFAULT_FILTERS);
  const [typed, setTyped] = React.useState('');
  const [choosing, setChoosing] = React.useState(false);
  const areas = useIdeaAreas();
  const board = useIdeaBoard(filters);

  // The search runs a moment after the typing stops, as Customers' does.
  React.useEffect(() => {
    const timer = setTimeout(
      () => setFilters((f) => (f.search === typed.trim() ? f : { ...f, search: typed.trim() })),
      400,
    );
    return () => clearTimeout(timer);
  }, [typed]);

  const share = () => router.push(businessHref(business.id, 'ideas/share') as Href);
  const filtered = isFiltered(filters);
  const chosen = [filters.status !== 'open', filters.mine !== null, filters.areaId !== null].filter(
    Boolean,
  ).length;

  return (
    <Screen
      title={IDEAS_WORDS.title}
      leading="back"
      back={businessHref(business.id, 'more')}
      scroll={false}
      testID="ideas"
      trailing={
        <Pressable
          role="button"
          accessibilityLabel={IDEAS_WORDS.share}
          onPress={share}
          testID="share-idea"
          className="size-11 items-center justify-center rounded-full active:bg-card-2"
        >
          <Icon as={Plus} className="size-[22px] text-accent" />
        </Pressable>
      }
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <IdeasTabs current="ideas" />
        <Input
          value={typed}
          onChangeText={setTyped}
          placeholder={IDEAS_WORDS.search}
          accessibilityLabel={IDEAS_WORDS.search}
          returnKeyType="search"
          autoCorrect={false}
          testID="ideas-search"
          className="h-11"
          trailing={
            typed ? (
              <Pressable
                role="button"
                accessibilityLabel="Clear"
                onPress={() => setTyped('')}
                hitSlop={8}
                className="size-11 items-center justify-center"
              >
                <Icon as={X} className="size-4 text-text-3" />
              </Pressable>
            ) : (
              <View className="size-11 items-center justify-center">
                <Icon as={Search} className="size-4 text-text-3" />
              </View>
            )
          }
        />
        <View className="flex-row items-center gap-2">
          <Segmented
            className="flex-1"
            value={filters.sort}
            onChange={(sort: IdeaSort) => setFilters((f) => ({ ...f, sort }))}
            label={IDEAS_WORDS.sortLabel}
            options={IDEA_SORTS.map((s) => ({
              value: s,
              label: IDEA_SORT_WORDS[s],
              testID: `ideas-sort-${s}`,
            }))}
          />
          <Button
            variant="secondary"
            size="md"
            icon={SlidersHorizontal}
            onPress={() => setChoosing(true)}
            accessibilityLabel={chosen ? `${IDEAS_WORDS.filters}: ${chosen}` : IDEAS_WORDS.filters}
            testID="ideas-filters-open"
          >
            {chosen ? String(chosen) : null}
          </Button>
        </View>
      </View>

      {board.data ? (
        <FlatList
          data={board.data.ideas}
          keyExtractor={(idea) => idea.id}
          renderItem={({ item }) => (
            <IdeaRowView
              idea={item}
              areas={areas}
              businessId={business.id}
              onVoted={(answer) =>
                board.update((was) => ({
                  ...was,
                  ideas: was.ideas.map((i) => (i.id === item.id ? { ...i, ...answer } : i)),
                }))
              }
            />
          )}
          contentContainerClassName="px-3.5 pb-8"
          initialNumToRender={10}
          windowSize={7}
          keyboardShouldPersistTaps="handled"
          testID="ideas-list"
          refreshControl={
            <RefreshControl
              refreshing={board.refreshing}
              onRefresh={board.reload}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <EmptyBoard
              filtered={filtered}
              onShare={share}
              onClear={() => {
                setTyped('');
                setFilters({ ...DEFAULT_FILTERS, sort: filters.sort });
              }}
            />
          }
          ListFooterComponent={
            board.hasMore ? (
              <Button
                variant="secondary"
                className="mt-4"
                loading={board.loadingMore}
                onPress={board.more}
                testID="ideas-more"
              >
                {IDEAS_WORDS.showMore}
              </Button>
            ) : null
          }
        />
      ) : (
        <View className="p-3">
          {board.loading ? (
            <IdeasLoading />
          ) : (
            <IdeasNeedSignal error={board.error} onRetry={board.reload} />
          )}
        </View>
      )}

      <IdeaFiltersSheet
        open={choosing}
        onClose={() => setChoosing(false)}
        filters={filters}
        areas={areas}
        onChange={(next) => {
          if (next.search !== filters.search) setTyped(next.search);
          setFilters(next);
        }}
      />
    </Screen>
  );
}

/** One idea on the board: its vote, its title and the start of its details, and where it stands. */
function IdeaRowView({
  idea,
  areas,
  businessId,
  onVoted,
}: {
  idea: IdeaRow;
  areas: readonly IdeaArea[];
  businessId: string;
  onVoted: (answer: { voted: boolean; voteCount: number }) => void;
}) {
  return (
    <View className="flex-row gap-3 border-b border-border py-3" testID="idea-row">
      <VoteButton
        ideaId={idea.id}
        voted={idea.voted}
        count={idea.voteCount}
        open={votingOpenFor(idea.status)}
        onVoted={onVoted}
      />
      <Pressable
        role="link"
        onPress={() => router.push(businessHref(businessId, `ideas/${idea.id}`) as Href)}
        className="min-w-0 flex-1 gap-1 active:opacity-70"
        testID={`idea-open-${idea.id}`}
      >
        <Text className="text-[15px] font-semibold leading-5" numberOfLines={3}>
          {idea.title}
        </Text>
        {idea.excerpt ? (
          <Text className="text-[13px] leading-[18px] text-text-2" numberOfLines={2}>
            {idea.excerpt}
          </Text>
        ) : null}
        <View className="mt-0.5 flex-row flex-wrap items-center gap-x-2 gap-y-1">
          <StatusPill status={idea.status} />
          <Text className="text-xs text-text-3" numberOfLines={1}>
            {areaName(areas, idea.areaId)}
          </Text>
          {idea.commentCount ? (
            <View className="flex-row items-center gap-1">
              <Icon as={MessageSquare} className="size-3.5 text-text-3" />
              <Text className="text-xs text-text-3">{String(idea.commentCount)}</Text>
            </View>
          ) : null}
          <Text className="text-xs text-text-3" numberOfLines={1}>
            {`${idea.author.you ? IDEAS_WORDS.you : idea.author.name || IDEAS_WORDS.someone} · ${relativeTimeAgo(idea.createdAt)}`}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

/** Nothing on the board: the first idea to share, or filters that found nothing. */
function EmptyBoard({
  filtered,
  onShare,
  onClear,
}: {
  filtered: boolean;
  onShare: () => void;
  onClear: () => void;
}) {
  return (
    <Card className="mt-3 items-center gap-2 px-5 py-8" testID="ideas-empty">
      <Icon as={Lightbulb} className="size-6 text-text-3" />
      <Text className="text-base font-semibold">
        {filtered ? IDEAS_WORDS.noMatch : IDEAS_WORDS.noIdeas}
      </Text>
      <Text className="text-center text-[13.5px] leading-5 text-text-2">
        {filtered ? IDEAS_WORDS.noMatchBody : IDEAS_WORDS.noIdeasBody}
      </Text>
      {filtered ? (
        <Button variant="secondary" className="mt-1 self-stretch" onPress={onClear}>
          {IDEAS_WORDS.clearFilters}
        </Button>
      ) : (
        <Button className="mt-1 self-stretch" onPress={onShare} testID="ideas-share-first">
          {IDEAS_WORDS.shareFirst}
        </Button>
      )}
    </Card>
  );
}
