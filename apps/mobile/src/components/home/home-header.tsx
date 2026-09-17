import { ATTENTION_WORDS, attentionHeaderWords, type AttentionScope } from '@hfos/core';
import { View } from 'react-native';

import { UpToDate } from '@/components/shell/up-to-date';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';

/**
 * The top of Home, as the canvas draws it: "Good morning, Dale · Tue, Sep 22" with the quiet "Up to date" line, then
 * "$49,852 affected", "10 need attention · 2 urgent · 3 handled today", and Mine / Everyone across the band.
 */
export function HomeHeader({
  greeting,
  total,
  urgent,
  handledToday,
  affectedCents,
  scope,
  onScope,
}: {
  greeting: string;
  total: number;
  urgent: number;
  handledToday: number;
  affectedCents: number;
  scope: AttentionScope;
  onScope: (scope: AttentionScope) => void;
}) {
  const words = attentionHeaderWords({ total, urgent, handledToday, affectedCents });
  return (
    <View
      className="gap-0.5 border-b border-border bg-card px-4 pb-3 pt-3"
      testID="attention-header"
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-[13px] text-text-3" numberOfLines={1} testID="home-greeting">
          {greeting}
        </Text>
        <UpToDate />
      </View>
      <Text
        className="text-[26px] font-semibold leading-[32px] tracking-[-0.4px]"
        accessibilityHint={words.title ?? undefined}
        testID="attention-affected"
      >
        {words.headline.figure}
        {words.headline.words ? (
          <Text className="text-xl font-medium tracking-[-0.1px] text-text-2">
            {' '}
            {words.headline.words}
          </Text>
        ) : null}
      </Text>
      <Text className="mt-0.5 text-[13.5px] text-text-2" testID="attention-counts">
        {words.need ? (
          <>
            <Text className="text-[13.5px] font-semibold text-text">{words.need.count}</Text>{' '}
            {words.need.words} ·{' '}
          </>
        ) : null}
        {words.urgent ? (
          <>
            <Text className="text-[13.5px] font-semibold text-danger-text">{words.urgent}</Text>{' '}
            ·{' '}
          </>
        ) : null}
        {words.handled}
      </Text>
      <Segmented<AttentionScope>
        label="Whose items"
        value={scope}
        onChange={onScope}
        className="mt-2.5"
        options={[
          { value: 'mine', label: ATTENTION_WORDS.mine, testID: 'scope-mine' },
          { value: 'everyone', label: ATTENTION_WORDS.everyone, testID: 'scope-everyone' },
        ]}
      />
    </View>
  );
}
