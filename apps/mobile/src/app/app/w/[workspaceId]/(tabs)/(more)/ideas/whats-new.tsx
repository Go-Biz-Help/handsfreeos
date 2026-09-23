import { IDEA_STATUS_WORDS, IDEAS_WORDS, ideaDay } from '@hfos/core';
import { router, type Href } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';

import { ChevronUp, Megaphone } from '@/components/icons';
import { IdeasLoading, IdeasNeedSignal, KindPill, PlainText } from '@/components/ideas/idea-bits';
import { IdeasTabs } from '@/components/ideas/ideas-tabs';
import { businessHref, useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import {
  areaName,
  ideaCommands,
  useIdeaAreas,
  useWhatsNew,
  type WhatsNewEntry,
} from '@/ideas/use-ideas';
import { whatsNewRead } from '@/ideas/whats-new-signal';
import { useColors } from '@/theme';

/**
 * What's new in HandsFreeOS, newest first: what shipped, what got better, what got fixed, and the ideas each one
 * answers, so the people who asked can see it was them. Reading it is what puts "New" out, so it is marked read once
 * the entries have come down, not merely when the screen opens with no signal.
 */
export default function WhatsNew() {
  const { business } = useBusiness();
  const colors = useColors();
  const list = useWhatsNew();
  const areas = useIdeaAreas();
  const marked = React.useRef(false);
  const loaded = list.data !== null;

  React.useEffect(() => {
    if (!loaded || marked.current) return;
    marked.current = true;
    whatsNewRead();
    // "New" going out here is enough; the next time the phone asks is soon enough to learn otherwise.
    void ideaCommands.markSeen().catch(() => undefined);
  }, [loaded]);

  return (
    <Screen
      title={IDEAS_WORDS.tabs.whatsNew}
      leading="back"
      back={businessHref(business.id, 'more')}
      scroll={false}
      testID="whats-new"
    >
      <View className="gap-3 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <IdeasTabs current="whats-new" />
      </View>

      {list.data ? (
        <FlatList
          data={list.data.entries}
          keyExtractor={(e) => e.id}
          renderItem={({ item }) => (
            <EntryCard
              entry={item}
              area={item.areaId ? areaName(areas, item.areaId) : null}
              onOpen={(id) => router.push(businessHref(business.id, `ideas/${id}`) as Href)}
            />
          )}
          contentContainerClassName="gap-3 px-3.5 pb-8 pt-3"
          testID="whats-new-list"
          refreshControl={
            <RefreshControl
              refreshing={list.refreshing}
              onRefresh={list.reload}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <Card className="items-center gap-2 px-5 py-8" testID="whats-new-empty">
              <Icon as={Megaphone} className="size-6 text-text-3" />
              <Text className="text-base font-semibold">{IDEAS_WORDS.whatsNewEmpty}</Text>
              <Text className="text-center text-[13.5px] leading-5 text-text-2">
                {IDEAS_WORDS.whatsNewEmptyBody}
              </Text>
            </Card>
          }
          ListFooterComponent={
            list.hasMore ? (
              <Button
                variant="secondary"
                loading={list.loadingMore}
                onPress={list.more}
                testID="whats-new-more"
              >
                {IDEAS_WORDS.showOlder}
              </Button>
            ) : null
          }
        />
      ) : (
        <View className="p-3">
          {list.loading ? (
            <IdeasLoading />
          ) : (
            <IdeasNeedSignal error={list.error} onRetry={list.reload} />
          )}
        </View>
      )}
    </Screen>
  );
}

function EntryCard({
  entry,
  area,
  onOpen,
}: {
  entry: WhatsNewEntry;
  area: string | null;
  onOpen: (ideaId: string) => void;
}) {
  return (
    <Card className="gap-2.5 px-3.5 py-4" testID="whats-new-entry">
      <View className="flex-row flex-wrap items-center gap-2">
        <KindPill kind={entry.kind} />
        {entry.publishedAt ? (
          <Text className="text-[12.5px] text-text-3">{ideaDay(entry.publishedAt)}</Text>
        ) : null}
        {area ? <Text className="text-[12.5px] text-text-3">{`· ${area}`}</Text> : null}
        {entry.unseen ? (
          <Badge variant="accent" testID="whats-new-unseen">
            <Text className="font-semibold">{IDEAS_WORDS.newForYou}</Text>
          </Badge>
        ) : null}
      </View>
      <Text className="text-[17px] font-semibold leading-6 tracking-[-0.17px]">{entry.title}</Text>
      {entry.body ? <PlainText text={entry.body} /> : null}
      {entry.ideas.length ? (
        <View className="gap-1.5 border-t border-border pt-3">
          <Text className="text-xs font-medium text-text-3">{IDEAS_WORDS.answers}</Text>
          {entry.ideas.map((i) => (
            <Pressable
              key={i.id}
              role="link"
              onPress={() => onOpen(i.id)}
              className="min-h-9 flex-row items-center gap-2 active:opacity-70"
              testID="whats-new-idea"
            >
              <View className="flex-row items-center gap-0.5">
                <Icon as={ChevronUp} className="size-3.5 text-text-3" />
                <Text className="text-[12.5px] text-text-3">{String(i.voteCount)}</Text>
              </View>
              <Text className="min-w-0 flex-1 text-[13.5px]" numberOfLines={1}>
                {`#${i.number} ${i.title}`}
              </Text>
              <Text className="text-xs text-text-3">{IDEA_STATUS_WORDS[i.status]}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
