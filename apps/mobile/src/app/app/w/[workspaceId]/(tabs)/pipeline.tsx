import { pipelineSummary, PIPELINE_WORDS, type LeadCard } from '@hfos/core';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import { ChevronDown } from '@/components/icons';
import { LeadCardView, StageChips, StageEmpty, StageTotals } from '@/components/pipeline/bits';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useNow } from '@/inbox/use-inbox';
import { useBoard } from '@/pipeline/use-pipeline';

/**
 * The Pipeline tab. A board can't fit a phone, so it is one stage at a time with chips along the top that say how many
 * leads each holds (the canvas). Everything is read from the phone's copy, and the list is virtualized so the largest
 * business stays smooth.
 */
export default function Pipeline() {
  const { business } = useBusiness();
  const params = useLocalSearchParams<{ pipeline?: string; stage?: string }>();
  const [pipelineId, setPipelineId] = React.useState<string | null>(params.pipeline ?? null);
  const board = useBoard(pipelineId);
  const [stageId, setStageId] = React.useState<string | null>(null);
  const [picking, setPicking] = React.useState(false);
  const now = useNow(60_000);

  // The first open stage, until someone picks another; a new pipeline starts at its own first stage.
  const stages = board.stages;
  const current =
    stages.find((s) => s.id === stageId) ?? stages.find((s) => s.kind === 'open') ?? stages[0];

  const open = React.useCallback(
    (id: string) => router.push(businessHref(business.id, `leads/${id}`) as Href),
    [business.id],
  );
  const renderItem = React.useCallback(
    ({ item }: { item: LeadCard }) => (
      <LeadCardView lead={item} nextAction={item.nextAction} now={now} onPress={open} />
    ),
    [now, open],
  );

  return (
    <Screen title={PIPELINE_WORDS.title} testID="pipeline" scroll={false}>
      <View className="gap-2.5 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="min-w-0 flex-1 text-[13px] text-text-2" testID="pipeline-summary">
            {pipelineSummary(board.openCount, board.openValueCents)}
          </Text>
          {board.pipelines.length > 1 ? (
            <Pressable
              role="button"
              onPress={() => setPicking(true)}
              className="min-h-11 flex-row items-center gap-1.5 px-1"
              testID="pipeline-switch"
            >
              <Text className="text-[13px] font-medium text-accent-text">
                {board.pipeline?.name ?? ''}
              </Text>
              <Icon as={ChevronDown} className="size-4 text-accent-text" />
            </Pressable>
          ) : null}
        </View>
        <StageChips
          stages={stages.map((s) => ({ id: s.id, name: s.name, count: s.count }))}
          stageId={current?.id ?? null}
          onChange={setStageId}
        />
        {current ? <StageTotals count={current.count} valueCents={current.valueCents} /> : null}
      </View>

      <FlatList
        data={current ? [...current.leads] : []}
        keyExtractor={(lead) => lead.id}
        renderItem={renderItem}
        contentContainerClassName="gap-2.5 p-3 pb-8"
        initialNumToRender={10}
        windowSize={7}
        keyboardShouldPersistTaps="handled"
        testID="pipeline-list"
        ListEmptyComponent={
          board.loading ? null : current ? (
            <StageEmpty name={current.name} />
          ) : (
            <View className="items-center gap-1 py-10" testID="pipeline-empty">
              <Text className="text-[15px] font-semibold">{PIPELINE_WORDS.noLeadsTitle}</Text>
              <Text className="px-6 text-center text-[13px] text-text-2">
                {PIPELINE_WORDS.noLeadsBody}
              </Text>
            </View>
          )
        }
      />

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title="Pipeline"
        testID="pipeline-sheet"
      >
        <View className="gap-1">
          {board.pipelines.map((p) => (
            <Pressable
              key={p.id}
              role="button"
              onPress={() => {
                setPipelineId(p.id);
                setStageId(null);
                setPicking(false);
              }}
              className="min-h-14 justify-center rounded-menu px-3"
              testID={`pipeline-${p.name}`}
            >
              <Text className="text-[15px]">{p.name}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}
