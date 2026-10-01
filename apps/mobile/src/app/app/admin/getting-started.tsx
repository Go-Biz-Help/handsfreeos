import {
  DESK_ONBOARDING_WINDOWS,
  DESK_ONBOARDING_WORDS,
  deskMatomoPagesUrl,
  deskOnboardingCards,
  deskOnboardingWindow,
  deskSectionLabel,
  stepTitle,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { whenWords } from '@/admin/words';
import { desk, useLive } from '@/admin/live';
import { DeskWaiting, Empty, FilterChips, Section } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { ChartLine } from '@/components/icons';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { openWeb } from '@/lib/open-web';
import { useColors } from '@/theme';

/**
 * How Getting started is going, everywhere (the web's /admin/getting-started, the onboarding plan's §9): how many
 * businesses answer the quick questions, which steps they skip, and how many finish, over the last 7, 30 or 90 days.
 * Counted from the onboarding events; how far people get through the wizard's pages is Matomo's half, a press away in
 * the browser.
 */
export default function GettingStarted() {
  const canRead = useDeskCan('platform.businesses.read');
  if (!canRead)
    return (
      <Screen
        title={deskSectionLabel('getting-started')}
        leading="back"
        back={deskHref()}
        testID="desk-getting-started"
      >
        <Empty
          title={DESK_BUSINESS_PHONE_WORDS.notYourRole('getting-started')}
          testID="getting-started-not-yours"
        />
      </Screen>
    );
  return <Counts />;
}

function Counts() {
  const colors = useColors();
  // 30 days, unless a link to the web's page asked for another window (?days=7).
  const linked = useLocalSearchParams<{ days?: string }>().days;
  const [days, setDays] = React.useState<number>(() => deskOnboardingWindow(linked));
  const live = useLive(
    () => desk('/v1/queries/platform.onboarding.counts', { days }),
    `onboarding-${days}`,
  );
  const c = live.data;

  return (
    <Screen
      title={deskSectionLabel('getting-started')}
      subtitle={c ? DESK_ONBOARDING_WORDS.since(whenWords(c.since)) : undefined}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-getting-started"
    >
      <View className="border-b border-border bg-card px-3.5 py-3">
        <FilterChips
          options={DESK_ONBOARDING_WINDOWS.map((d) => ({
            key: String(d),
            label: DESK_ONBOARDING_WORDS.lastDays(d),
          }))}
          value={String(days)}
          onChange={(key) => setDays(deskOnboardingWindow(key))}
          testID="onboarding-window"
        />
      </View>

      {c ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-3 p-3 pb-8"
          refreshControl={
            <RefreshControl
              refreshing={live.refreshing}
              onRefresh={live.reload}
              tintColor={colors.accent}
            />
          }
        >
          <View className="flex-row flex-wrap gap-2">
            {deskOnboardingCards(c).map((card) => (
              <Card
                key={card.id}
                className="min-w-[46%] flex-1 gap-0.5 px-3.5 py-3"
                testID={`onboarding-count-${card.id}`}
              >
                <Text className="text-[12.5px] text-text-3">{card.label}</Text>
                <Text className="text-xl font-semibold tabular-nums">{String(card.value)}</Text>
                {card.note ? <Text className="text-xs text-text-3">{card.note}</Text> : null}
              </Card>
            ))}
          </View>

          <Section
            title={DESK_ONBOARDING_WORDS.skippedTitle}
            detail={DESK_ONBOARDING_WORDS.skippedExplain}
            testID="onboarding-steps"
          >
            <View className="flex-row gap-3 border-b border-border pb-1.5">
              <Text className="min-w-0 flex-1 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {DESK_ONBOARDING_WORDS.step}
              </Text>
              <Text className="w-16 text-right text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {DESK_ONBOARDING_WORDS.skipped}
              </Text>
              <Text className="w-[88px] text-right text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
                {DESK_ONBOARDING_WORDS.broughtBack}
              </Text>
            </View>
            {c.steps.map((s) => (
              <View
                key={s.key}
                className="flex-row items-baseline gap-3"
                testID={`onboarding-step-${s.key}`}
              >
                <View className="min-w-0 flex-1 gap-px">
                  <Text className="text-[14px] font-medium">{stepTitle(s.key)}</Text>
                  <Text className="text-xs text-text-3">
                    {DESK_ONBOARDING_WORDS.stepFor[s.for]}
                  </Text>
                </View>
                <Text className="w-16 text-right text-[14px] tabular-nums">
                  {String(s.skipped)}
                </Text>
                <Text className="w-[88px] text-right text-[14px] tabular-nums text-text-2">
                  {String(s.broughtBack)}
                </Text>
              </View>
            ))}
          </Section>

          <Section title={DESK_ONBOARDING_WORDS.howFarTitle} testID="onboarding-how-far">
            <Text className="text-[13.5px] leading-[20px] text-text-2">
              {DESK_ONBOARDING_WORDS.howFar.map((part, i) =>
                typeof part === 'string' ? (
                  part
                ) : (
                  <Text key={i} className="font-mono text-[12.5px] text-text">
                    {part.code}
                  </Text>
                ),
              )}
            </Text>
            <Button
              variant="secondary"
              size="md"
              icon={ChartLine}
              onPress={() => void openWeb(deskMatomoPagesUrl(days))}
              testID="onboarding-matomo"
            >
              {DESK_ONBOARDING_WORDS.openMatomo}
            </Button>
          </Section>
        </ScrollView>
      ) : (
        <DeskWaiting live={live} testID="getting-started" />
      )}
    </Screen>
  );
}
