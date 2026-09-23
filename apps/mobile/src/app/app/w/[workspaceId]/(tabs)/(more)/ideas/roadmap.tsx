import { IDEA_STATUS_MEANING, IDEA_STATUS_WORDS, IDEAS_WORDS, ideaDay } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { IdeasLoading, IdeasNeedSignal } from '@/components/ideas/idea-bits';
import { IdeasTabs } from '@/components/ideas/ideas-tabs';
import { VoteButton } from '@/components/ideas/vote-button';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import {
  areaName,
  useIdeaAreas,
  useRoadmap,
  type Roadmap as RoadmapData,
  type RoadmapCard,
} from '@/ideas/use-ideas';
import { useColors } from '@/theme';

type Column = 'planned' | 'in_progress' | 'done';

const KEY: Record<Column, keyof RoadmapData> = {
  planned: 'planned',
  in_progress: 'inProgress',
  done: 'done',
};

/**
 * The roadmap on the phone: what the team is going to build, what it is building, and what shipped in the last
 * ninety days. The web's three columns don't fit side by side here, so they are three views of one list, each
 * saying what it means. Planned and in progress are ordered by votes, as the team reads them.
 */
export default function Roadmap() {
  const { business } = useBusiness();
  const colors = useColors();
  const [column, setColumn] = React.useState<Column>('planned');
  const roadmap = useRoadmap();
  const areas = useIdeaAreas();
  const data = roadmap.data;
  const count = (c: Column) => (data ? ` · ${data[KEY[c]].length}` : '');

  return (
    <Screen
      title={IDEAS_WORDS.tabs.roadmap}
      leading="back"
      back={businessHref(business.id, 'more')}
      scroll={false}
      testID="roadmap"
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <IdeasTabs current="roadmap" />
        <Segmented
          value={column}
          onChange={setColumn}
          label={IDEAS_WORDS.tabs.roadmap}
          options={[
            {
              value: 'planned',
              label: `${IDEA_STATUS_WORDS.planned}${count('planned')}`,
              testID: 'roadmap-planned',
            },
            {
              value: 'in_progress',
              label: `${IDEA_STATUS_WORDS.in_progress}${count('in_progress')}`,
              testID: 'roadmap-in_progress',
            },
            {
              value: 'done',
              label: `${IDEA_STATUS_WORDS.done}${count('done')}`,
              testID: 'roadmap-done',
            },
          ]}
        />
      </View>

      {data ? (
        <FlatList
          data={data[KEY[column]]}
          keyExtractor={(card) => card.id}
          renderItem={({ item }) => (
            <RoadmapRow
              card={item}
              column={column}
              area={areaName(areas, item.areaId)}
              onOpen={() => router.push(businessHref(business.id, `ideas/${item.id}`) as Href)}
            />
          )}
          contentContainerClassName="gap-2 px-3.5 pb-8 pt-3"
          testID={`roadmap-list-${column}`}
          refreshControl={
            <RefreshControl
              refreshing={roadmap.refreshing}
              onRefresh={roadmap.reload}
              tintColor={colors.accent}
            />
          }
          ListHeaderComponent={
            <Text className="px-1 pb-1 text-[13px] leading-5 text-text-3">
              {IDEA_STATUS_MEANING[column]}
            </Text>
          }
          ListEmptyComponent={
            <Card className="border-dashed px-5 py-8" testID="roadmap-empty">
              <Text className="text-center text-[13.5px] leading-5 text-text-3">
                {IDEAS_WORDS.roadmapEmpty[column]}
              </Text>
            </Card>
          }
        />
      ) : (
        <View className="p-3">
          {roadmap.loading ? (
            <IdeasLoading />
          ) : (
            <IdeasNeedSignal error={roadmap.error} onRetry={roadmap.reload} />
          )}
        </View>
      )}
    </Screen>
  );
}

function RoadmapRow({
  card,
  column,
  area,
  onOpen,
}: {
  card: RoadmapCard;
  column: Column;
  area: string;
  onOpen: () => void;
}) {
  return (
    <Card className="flex-row gap-3 p-3" testID="roadmap-card">
      <VoteButton
        ideaId={card.id}
        voted={card.voted}
        count={card.voteCount}
        open={column !== 'done'}
      />
      <Pressable role="link" onPress={onOpen} className="min-w-0 flex-1 gap-1 active:opacity-70">
        <Text className="text-[15px] font-semibold leading-5" numberOfLines={3}>
          {card.title}
        </Text>
        <Text className="text-xs text-text-3">
          {column === 'done' && card.statusChangedAt
            ? `${area} · ${ideaDay(card.statusChangedAt)}`
            : area}
        </Text>
      </Pressable>
    </Card>
  );
}
