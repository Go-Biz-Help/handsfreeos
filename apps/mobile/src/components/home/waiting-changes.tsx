import * as React from 'react';
import { Pressable, View } from 'react-native';

import { CircleAlert, CloudUpload } from '@/components/icons';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { changes } from '@/changes';
import type { HomeChange } from '@/home/build';
import { HOME_PHONE_WORDS, refusedLine, waitingLine } from '@/home/words';

/**
 * Home's changes made on this phone that haven't reached HandsFreeOS yet, over the list: a snoozed or dismissed card
 * leaves at once, and shows here until it goes, with Undo while it's still on the phone. A refused change whose item
 * isn't on Home (someone dismissed or cleared it first) says why here, with OK; one whose card is back says it there.
 */
export function WaitingChanges({
  changes: waiting,
  refused = [],
  titles,
}: {
  changes: readonly HomeChange[];
  refused?: readonly HomeChange[];
  titles: ReadonlyMap<string, string>;
}) {
  if (!waiting.length && !refused.length) return null;
  return (
    <View className="gap-3">
      {refused.map((c) => (
        <View
          key={c.row.id}
          role="alert"
          testID="home-refused"
          className="flex-row items-start gap-2.5 rounded-card bg-danger-soft px-3.5 py-3"
        >
          <Icon as={CircleAlert} strokeWidth={1.75} className="mt-px size-4 text-danger-text" />
          <View className="min-w-0 flex-1 gap-0.5">
            <Text numberOfLines={1} className="text-[13.5px] font-semibold text-danger-text">
              {titles.get(c.itemId) ?? ''}
            </Text>
            <Text
              className="text-[13px] leading-[19px] text-danger-text"
              testID="home-refused-text"
            >
              {refusedLine(c)}
            </Text>
          </View>
          <Pressable
            role="button"
            hitSlop={10}
            testID="home-refused-ok"
            onPress={() => void changes.discard([c.row.id])}
          >
            <Text className="text-[13px] font-semibold text-danger-text">
              {HOME_PHONE_WORDS.dismissNote}
            </Text>
          </Pressable>
        </View>
      ))}
      {waiting.length ? <WaitingCard waiting={waiting} titles={titles} /> : null}
    </View>
  );
}

function WaitingCard({
  waiting,
  titles,
}: {
  waiting: readonly HomeChange[];
  titles: ReadonlyMap<string, string>;
}) {
  return (
    <Card testID="home-waiting">
      <View className="flex-row items-center gap-2 px-3.5 pb-2 pt-3">
        <Icon as={CloudUpload} className="size-4 text-accent-text" />
        <Text className="flex-1 text-[13.5px] font-semibold" testID="home-waiting-title">
          {HOME_PHONE_WORDS.waitingTitle(waiting.length)}
        </Text>
      </View>
      {waiting.map((c) => (
        <View
          key={c.row.id}
          testID="home-waiting-row"
          className="min-h-11 flex-row items-center gap-3 border-t border-border px-3.5 py-2"
        >
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-[13.5px]">
              {waitingLine(c, titles.get(c.itemId) ?? null)}
            </Text>
            <Text className="text-xs text-text-3">{HOME_PHONE_WORDS.goesWhenOnline}</Text>
          </View>
          {c.row.state !== 'sending' ? (
            <Pressable
              role="button"
              hitSlop={10}
              testID="home-waiting-undo"
              onPress={() => void changes.discard([c.row.id])}
            >
              <Text className="text-[13.5px] font-semibold text-accent-text">
                {HOME_PHONE_WORDS.undo}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
