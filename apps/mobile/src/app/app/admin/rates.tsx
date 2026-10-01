import {
  deskSectionLabel,
  money,
  RATES_WORDS,
  rateCostWords,
  rateIsThin,
  rateMarkupWords,
  rateRealisedWords,
  rateThinWarning,
} from '@hfos/core';
import * as React from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { desk, useLive, type Ok } from '@/admin/live';
import { MONEY_DESK_WORDS, RATE_WINDOWS, type RateWindow } from '@/admin/money-desk-words';
import { DeskWaiting, Line } from '@/components/admin/bits';
import { OnlyAdmins } from '@/components/admin/money-desk-bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Screen } from '@/components/shell/screen';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { useColors } from '@/theme';

type RateLine = Ok<'/v1/queries/platform.rates'>['lines'][number];

/**
 * Rates (the web's /admin/rates, M16 step 8): the live usage rate card, and whether it is holding. The margin is the
 * reason the page exists: a line charging under 1.2× what it costs us is flagged at the top, which is the standing
 * alert the plan asks for. Each line is a card here rather than a row of a table. For support admins
 * (`platform.rates.manage`); the card is changed with `private.publish_usage_rates`, not here.
 */
export default function Rates() {
  const can = useDeskCan('platform.rates.manage');
  return can ? <RateCard /> : <OnlyAdmins section="rates" />;
}

function RateCard() {
  const colors = useColors();
  const [days, setDays] = React.useState<RateWindow>(30);
  const live = useLive(() => desk('/v1/queries/platform.rates', { days }), `rates-${days}`);
  const card = live.data;
  const thin = card ? rateThinWarning(card.lines) : null;

  return (
    <Screen
      title={deskSectionLabel('rates')}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-rates"
    >
      <View className="gap-2 border-b border-border bg-card px-3.5 pb-3 pt-3">
        <Segmented<string>
          label={MONEY_DESK_WORDS.measuredOver}
          value={String(days)}
          onChange={(d) => setDays(Number(d) as RateWindow)}
          options={RATE_WINDOWS.map((w) => ({
            value: String(w.days),
            label: w.label,
            testID: `rates-window-${w.days}`,
          }))}
          testID="rates-window"
        />
        {card ? (
          <Text className="text-[13px] text-text-3" testID="rates-measured">
            {RATES_WORDS.measured(card.version, days)}
          </Text>
        ) : null}
      </View>

      {card ? (
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
          {thin ? (
            <View className="rounded-[10px] bg-danger-soft px-3.5 py-3" testID="rates-thin">
              <Text className="text-[13.5px] leading-[19px] text-danger-text">{thin}</Text>
            </View>
          ) : null}
          {card.lines.map((line) => (
            <RateLineCard key={line.key} line={line} />
          ))}
          <Text className="px-1 text-[13px] leading-[19px] text-text-3">
            {RATES_WORDS.notEditable}{' '}
            <Text className="font-mono text-[12.5px] text-text-2">
              {RATES_WORDS.publishFunction}
            </Text>
            .
          </Text>
        </ScrollView>
      ) : (
        <DeskWaiting live={live} testID="rates" />
      )}
    </Screen>
  );
}

/** One line of the card: what it is, what it costs us, what it charges, and what it actually realised. */
function RateLineCard({ line }: { line: RateLine }) {
  const thin = rateIsThin(line);
  return (
    <Card className="gap-2 px-4 py-3" testID={`rate-${line.key}`}>
      <View className="gap-0.5">
        <Text className="font-mono text-[13.5px] font-medium">{line.key}</Text>
        {line.notes ? <Text className="text-[12.5px] text-text-3">{line.notes}</Text> : null}
      </View>
      <Line label={RATES_WORDS.costsUs} value={rateCostWords(line.costMicros)} />
      <Line
        label={RATES_WORDS.charged}
        value={`${money(line.unitPriceCents)} · ${rateMarkupWords(line.markupBp / 10_000)}`}
      />
      <Line
        label={RATES_WORDS.realised}
        testID={`rate-${line.key}-realised`}
        value={
          line.realised ? (
            <View className="min-w-0 flex-shrink items-end">
              <Text
                className={cn(
                  'font-mono text-[13.5px]',
                  thin ? 'font-semibold text-danger-text' : 'text-text',
                )}
              >
                {rateMarkupWords(line.realised.markup)}
              </Text>
              <Text className="text-right text-xs text-text-3">
                {rateRealisedWords(line.realised)}
              </Text>
            </View>
          ) : (
            <Text className="text-[13.5px] text-text-3">{RATES_WORDS.nothingYet}</Text>
          )
        }
      />
    </Card>
  );
}
