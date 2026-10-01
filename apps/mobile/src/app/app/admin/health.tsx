import {
  DESK_AI_MODE_WORDS,
  DESK_AI_MODES,
  DESK_AI_WORDS,
  DESK_HEALTH_WORDS,
  deskAiFacts,
  deskAiOverruled,
  deskAiWhy,
  deskHealthCards,
  deskHealthHours,
  deskSectionLabel,
  type DeskAiMode,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { whenWords } from '@/admin/words';
import { desk, useLive, type Ok } from '@/admin/live';
import { DESK_PHONE_WORDS } from '@/admin/words';
import { DeskWaiting, Empty, Line, Section } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type AiProvider = Ok<'/v1/queries/platform.ai_provider.get'>;

/**
 * What has gone wrong lately, everywhere (the web's /admin/health): the point is to find it before a customer does.
 * The counts over the last day, which AI is answering and why, and the last few things that failed. Which AI answers
 * is asked on its own, as on the web: when it can't be read, the rest of the page still can.
 */
export default function Health() {
  const canRead = useDeskCan('platform.health.read');
  if (!canRead)
    return (
      <Screen
        title={deskSectionLabel('health')}
        leading="back"
        back={deskHref()}
        testID="desk-health"
      >
        <Empty title={DESK_BUSINESS_PHONE_WORDS.notYourRole('health')} testID="health-not-yours" />
      </Screen>
    );
  return <HealthPage />;
}

function HealthPage() {
  const colors = useColors();
  const canSwitch = useDeskCan('platform.ai.manage');
  // The last day, unless a link to the web's page asked for another window (?hours=72), as the web reads it.
  const hours = deskHealthHours(useLocalSearchParams<{ hours?: string }>().hours);
  const health = useLive(
    () => desk('/v1/queries/platform.health.summary', { hours }),
    `health-${hours}`,
  );
  const ai = useLive(() => desk('/v1/queries/platform.ai_provider.get', {}), 'ai-provider');

  const refresh = () => {
    health.reload();
    ai.reload();
  };

  const h = health.data;
  return (
    <Screen
      title={deskSectionLabel('health')}
      subtitle={h ? DESK_HEALTH_WORDS.since(whenWords(h.since), h.oldestPendingMinutes) : undefined}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-health"
    >
      {h ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-3 p-3 pb-8"
          refreshControl={
            <RefreshControl
              refreshing={health.refreshing || ai.refreshing}
              onRefresh={refresh}
              tintColor={colors.accent}
            />
          }
        >
          <View className="flex-row flex-wrap gap-2" testID="health-counts">
            {deskHealthCards(h).map((c) => (
              <Card key={c.label} className="min-w-[46%] flex-1 gap-0.5 px-3.5 py-3">
                <Text className="text-[12.5px] text-text-3">{c.label}</Text>
                <Text
                  className={cn(
                    'text-xl font-semibold tabular-nums',
                    c.value > 0 && 'text-danger-text',
                  )}
                >
                  {String(c.value)}
                </Text>
              </Card>
            ))}
          </View>

          <AiProviderSection
            ai={ai.data}
            failed={ai.error !== null && !ai.loading}
            canChange={canSwitch}
            onChanged={ai.reload}
          />

          <Section title={DESK_HEALTH_WORDS.lastFew} testID="health-recent">
            {h.recent.length === 0 ? (
              <Text className="text-[13.5px] text-text-3">{DESK_HEALTH_WORDS.nothingFailed}</Text>
            ) : (
              h.recent.map((r, i) => (
                <View key={`${r.at}-${i}`} className="gap-0.5">
                  <Text className="text-[13.5px]">
                    <Text className="text-[13.5px] font-medium">{r.kind}</Text>
                    <Text className="text-[13.5px] text-text-3">
                      {' '}
                      {r.business ?? DESK_HEALTH_WORDS.noBusiness} · {whenWords(r.at)}
                    </Text>
                  </Text>
                  <Text selectable className="text-[13px] leading-[18px] text-text-2">
                    {r.detail}
                  </Text>
                </View>
              ))
            )}
          </Section>
        </ScrollView>
      ) : (
        <DeskWaiting live={health} testID="health" />
      )}
    </Screen>
  );
}

/**
 * Which AI answers every business: Claude, or OpenAI while Claude is in trouble. On Auto the worker moves it by itself;
 * support keeps it on one when the checks get it wrong. Every worker follows within half a minute.
 */
function AiProviderSection({
  ai,
  failed,
  canChange,
  onChanged,
}: {
  ai: AiProvider | null;
  failed: boolean;
  canChange: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState(false);

  if (!ai)
    return (
      <Section title={DESK_AI_WORDS.title} testID="health-ai">
        <Text className="text-[13.5px] text-text-3" testID="health-ai-unread">
          {failed ? DESK_BUSINESS_PHONE_WORDS.aiUnreadable : DESK_BUSINESS_PHONE_WORDS.aiReading}
        </Text>
      </Section>
    );

  const pick = async (mode: DeskAiMode) => {
    if (mode === ai.mode || busy) return;
    setBusy(true);
    try {
      await desk('/v1/commands/ai_provider.set_mode', { mode });
      toast.show(DESK_PHONE_WORDS.saved);
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const why = deskAiWhy(ai, whenWords);
  const overruled = deskAiOverruled(ai);

  return (
    <Section title={DESK_AI_WORDS.title} testID="health-ai">
      <View className="gap-2">
        {deskAiFacts(ai, whenWords).map((f) => (
          <Line
            key={f.label}
            label={f.label}
            value={
              <Text
                className={cn(
                  'min-w-0 flex-shrink text-right text-[13.5px] font-semibold',
                  f.warn && 'text-warning-text',
                )}
              >
                {f.value}
              </Text>
            }
            testID={`health-ai-${f.label}`}
          />
        ))}
      </View>
      {why ? (
        <Text className="text-[13px] leading-[18px] text-text-2" testID="health-ai-why">
          {why}
        </Text>
      ) : null}
      {overruled ? (
        <Text className="text-[13px] leading-[18px] text-warning-text" testID="health-ai-overruled">
          {overruled}
        </Text>
      ) : null}
      {canChange ? (
        <Segmented<DeskAiMode>
          label={DESK_AI_WORDS.title}
          value={ai.mode}
          onChange={(mode) => void pick(mode)}
          options={DESK_AI_MODES.map((m) => ({
            value: m,
            label: DESK_AI_MODE_WORDS[m],
            testID: `ai-provider-${m}`,
            disabled: busy,
          }))}
        />
      ) : (
        <Text className="text-[13.5px] font-medium" testID="health-ai-mode">
          {DESK_AI_MODE_WORDS[ai.mode]}
        </Text>
      )}
      <Text className="text-[13px] leading-[18px] text-text-3">{DESK_AI_WORDS.autoExplain}</Text>
    </Section>
  );
}
