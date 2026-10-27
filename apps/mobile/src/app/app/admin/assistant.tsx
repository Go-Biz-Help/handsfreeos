import {
  assistantCoverage,
  coverageCards,
  coverageGapsForClaude,
  DESK_COVERAGE_WORDS,
  deskSectionLabel,
} from '@hfos/core';
import * as React from 'react';
import { ScrollView, Share, View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { Empty, Section } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Assistant coverage (the web's /admin/assistant): what Ask HandsFreeOS can't do yet, page by page in menu order,
 * shared for Claude (as the web's Copy gaps puts it) into a message or a note. It's read from the code, so it needs no
 * signal.
 */
export default function AssistantCoverageScreen() {
  const canRead = useDeskCan('platform.health.read');
  if (!canRead)
    return (
      <Screen
        title={deskSectionLabel('assistant')}
        leading="back"
        back={deskHref()}
        testID="desk-assistant"
      >
        <Empty
          title={DESK_BUSINESS_PHONE_WORDS.notYourRole('assistant')}
          testID="coverage-not-yours"
        />
      </Screen>
    );
  return <CoveragePage />;
}

function CoveragePage() {
  const c = React.useMemo(assistantCoverage, []);
  const share = async () => {
    try {
      await Share.share({ message: coverageGapsForClaude(c) });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <Screen
      title={deskSectionLabel('assistant')}
      subtitle={DESK_COVERAGE_WORDS.intro}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-assistant"
    >
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-3 pb-8">
        <Button onPress={() => void share()} testID="coverage-share">
          <Text>{DESK_COVERAGE_WORDS.share}</Text>
        </Button>

        <View className="flex-row flex-wrap gap-2" testID="coverage-counts">
          {coverageCards(c).map((card) => (
            <Card key={card.key} className="min-w-[46%] flex-1 gap-0.5 px-3.5 py-3">
              <Text className="text-[12.5px] text-text-3">{card.label}</Text>
              <Text
                className={cn('text-xl font-semibold tabular-nums', card.gap && 'text-danger-text')}
              >
                {card.value}
              </Text>
            </Card>
          ))}
        </View>

        <Section title={DESK_COVERAGE_WORDS.notYetTitle} testID="coverage-not-yet">
          {c.notYet.length === 0 ? (
            <Text className="text-[13.5px] text-text-3">{DESK_COVERAGE_WORDS.notYetNone}</Text>
          ) : (
            c.notYet.map((p) => (
              <View key={p.page} className="gap-0.5">
                <Text className="text-[13.5px] font-medium">{p.page}</Text>
                <Text className="text-[13px] leading-[18px] text-text-2">{p.why}</Text>
                <Text selectable className="text-[12.5px] text-text-3">
                  {p.actions.join(', ')}
                </Text>
              </View>
            ))
          )}
        </Section>

        <Section
          title={DESK_COVERAGE_WORDS.settingsTitle}
          detail={
            c.settingsToCheck.length === 0
              ? DESK_COVERAGE_WORDS.settingsNone
              : DESK_COVERAGE_WORDS.settingsDetail
          }
          testID="coverage-settings"
        >
          {c.settingsToCheck.map((p) => (
            <View key={p.key} className="gap-0.5">
              <Text className="text-[13.5px]">
                <Text className="text-[13.5px] font-medium">{p.label}</Text>
                <Text className="text-[13.5px] text-text-3">
                  {' '}
                  · {DESK_COVERAGE_WORDS.rows(p.rows.length)}
                </Text>
              </Text>
              <Text className="text-[13px] leading-[18px] text-text-2">{p.rows.join(' · ')}</Text>
            </View>
          ))}
        </Section>

        <Section
          title={DESK_COVERAGE_WORDS.neverTitle}
          detail={DESK_COVERAGE_WORDS.neverDetail}
          testID="coverage-never"
        >
          {c.never.map((n) => (
            <View key={n.command} className="gap-0.5">
              <Text selectable className="text-[12.5px] text-text-3">
                {n.command}
              </Text>
              <Text className="text-[13px] leading-[18px] text-text-2">{n.why}</Text>
            </View>
          ))}
        </Section>
      </ScrollView>
    </Screen>
  );
}
