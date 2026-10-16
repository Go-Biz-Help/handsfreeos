import {
  DESK_PROBLEM_WORDS,
  deskSectionLabel,
  PROBLEM_STATE_WORDS,
  PROBLEM_STATES,
  problemForClaude,
  problemFrom,
  problemWhere,
  type ProblemState,
} from '@hfos/core';
import * as React from 'react';
import { RefreshControl, ScrollView, Share, View } from 'react-native';

import { DESK_BUSINESS_PHONE_WORDS } from '@/admin/business-words';
import { desk, useLive, type Ok } from '@/admin/live';
import { whenWords } from '@/admin/words';
import { DeskWaiting, Empty, FilterChips } from '@/components/admin/bits';
import { deskHref, useDeskCan } from '@/components/admin/staff-context';
import { Screen } from '@/components/shell/screen';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { errorMessage } from '@/lib/api';
import { useColors } from '@/theme';

type Row = Ok<'/v1/queries/platform.problem_report.list'>['reports'][number];

/**
 * Problem reports (the web's /admin/problems): what our own tools saw when something didn't go, from every business,
 * newest first. Each is marked handled here, or shared for Claude (the report and its outline, as the web's Copy for
 * Claude puts it) into a message or a note.
 */
export default function Problems() {
  const canRead = useDeskCan('platform.health.read');
  if (!canRead)
    return (
      <Screen
        title={deskSectionLabel('problems')}
        leading="back"
        back={deskHref()}
        testID="desk-problems"
      >
        <Empty
          title={DESK_BUSINESS_PHONE_WORDS.notYourRole('problems')}
          testID="problems-not-yours"
        />
      </Screen>
    );
  return <ProblemsPage />;
}

function ProblemsPage() {
  const colors = useColors();
  const [state, setState] = React.useState<ProblemState>('open');
  const live = useLive(
    () => desk('/v1/queries/platform.problem_report.list', { state, limit: 50 }),
    `problems-${state}`,
  );
  const [busy, setBusy] = React.useState<string | null>(null);

  const mark = async (r: Row) => {
    if (busy) return;
    setBusy(r.reportId);
    try {
      await desk('/v1/commands/problem_report.set_handled', {
        reportIds: [r.reportId],
        handled: r.handledAt === null,
      });
      live.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const share = async (r: Row) => {
    try {
      const full = await desk('/v1/queries/platform.problem_report.get', {
        reportId: r.reportId,
      });
      await Share.share({ message: problemForClaude(full) });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const list = live.data;
  return (
    <Screen
      title={deskSectionLabel('problems')}
      subtitle={DESK_PROBLEM_WORDS.intro}
      leading="back"
      back={deskHref()}
      scroll={false}
      testID="desk-problems"
    >
      <View className="border-b border-border bg-card px-3.5 pb-3 pt-3">
        <FilterChips<ProblemState>
          options={PROBLEM_STATES.map((s) => ({ key: s, label: PROBLEM_STATE_WORDS[s] }))}
          value={state}
          onChange={setState}
          testID="problems-state"
        />
      </View>
      {list ? (
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
          {list.reports.length === 0 ? (
            <Empty title={DESK_PROBLEM_WORDS.none[state]} testID="problems-none" />
          ) : (
            list.reports.map((r) => (
              <Card
                key={r.reportId}
                className="gap-1.5 px-4 py-3.5"
                testID={`problem-${r.reportId}`}
              >
                <Text className="text-[15px] font-semibold">{problemWhere(r)}</Text>
                <Text className="text-[13px] text-text-3">
                  {r.business} · {whenWords(r.at)}
                </Text>
                <Text selectable className="text-[13.5px] leading-[19px] text-text-2">
                  {r.note ?? DESK_PROBLEM_WORDS.noNote}
                </Text>
                <Text className="text-[12.5px] text-text-3">{problemFrom(r)}</Text>
                <View className="mt-1 flex-row flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => void share(r)}
                    testID={`problem-share-${r.reportId}`}
                  >
                    <Text>{DESK_PROBLEM_WORDS.shareForClaude}</Text>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onPress={() => void mark(r)}
                    testID={`problem-mark-${r.reportId}`}
                  >
                    <Text>
                      {r.handledAt === null
                        ? DESK_PROBLEM_WORDS.markHandled
                        : DESK_PROBLEM_WORDS.reopen}
                    </Text>
                  </Button>
                </View>
              </Card>
            ))
          )}
        </ScrollView>
      ) : (
        <DeskWaiting live={live} testID="problems" />
      )}
    </Screen>
  );
}
