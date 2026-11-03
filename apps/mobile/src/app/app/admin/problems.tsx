import {
  DESK_HELPER_WORDS,
  DESK_PROBLEM_SECTION_WORDS,
  DESK_PROBLEM_WORDS,
  deskSectionLabel,
  helperBadge,
  helperMoveWords,
  HELPER_RESULT_WORDS,
  HELPER_VERDICT_WORDS,
  PROBLEM_LIMIT_BADGE,
  PROBLEM_STATE_WORDS,
  PROBLEM_STATES,
  problemClearedWords,
  problemForClaude,
  problemFrom,
  problemWhere,
  type ProblemReportFull,
  type ProblemState,
} from '@hfos/core';
import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { Pressable, RefreshControl, ScrollView, Share, View } from 'react-native';

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
type Steps = Ok<'/v1/queries/platform.problem_report.list'>['steps'];
type Groups = Ok<'/v1/queries/platform.problem_report.groups'>;
/** One problem picked from Needs a fix: its area and step. */
type Picked = { area: string; job: string };

/** A report's id from the address (`?report=…`, from a Needs you step's See what it saw, decision 142). */
const reportOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;

/**
 * Problem reports (the web's /admin/problems): what our own tools saw when something didn't go, from every business.
 * The open ones as two sections (20261027023100): the limits each business hit, on top, and what needs a fix grouped
 * by problem; one problem's reports, the handled ones and all of them as a list, newest first. Each is marked handled
 * here, or shared for Claude (the report and its outline, as the web's Copy for Claude puts it) into a message or a
 * note.
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
  const opened = reportOf(useLocalSearchParams<{ report?: string }>().report);
  const [state, setState] = React.useState<ProblemState>('open');
  const [picked, setPicked] = React.useState<Picked | null>(null);
  // The open ones with no problem picked are the two sections; the list still brings the week's steps.
  const grouped = state === 'open' && picked === null;
  const live = useLive(
    async () => ({
      list: await desk('/v1/queries/platform.problem_report.list', {
        state,
        ...(picked ?? {}),
        limit: grouped ? 1 : 50,
      }),
      groups: grouped ? await desk('/v1/queries/platform.problem_report.groups', {}) : null,
    }),
    `problems-${state}-${picked?.area ?? ''}-${picked?.job ?? ''}`,
  );
  const pickState = (next: ProblemState) => {
    setPicked(null);
    setState(next);
  };
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

  const list = live.data?.list ?? null;
  const groups = live.data?.groups ?? null;
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
          onChange={pickState}
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
          {opened ? <OpenedReport reportId={opened} /> : null}
          {groups ? (
            <>
              <LimitsCard limits={groups.limits} />
              <FixesCard fixes={groups.fixes} onPick={setPicked} />
              <StepsCard steps={list.steps} />
            </>
          ) : null}
          {picked ? (
            <Button size="sm" variant="ghost" onPress={() => setPicked(null)} testID="problems-all">
              <Text>{DESK_PROBLEM_WORDS.allProblems}</Text>
            </Button>
          ) : null}
          {groups ? null : list.reports.length === 0 ? (
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
                {r.kind === 'limit' ? (
                  <Text
                    className="text-[12.5px] font-medium text-warning-text"
                    testID={`problem-limit-${r.reportId}`}
                  >
                    {PROBLEM_LIMIT_BADGE}
                  </Text>
                ) : null}
                {problemClearedWords(r) ? (
                  <Text className="text-[12.5px] text-text-3">{problemClearedWords(r)}</Text>
                ) : null}
                {r.helper ? (
                  <Text
                    className="text-[12.5px] font-medium text-accent-text"
                    testID={`problem-helper-${r.reportId}`}
                  >
                    {helperBadge(r.helper)}
                  </Text>
                ) : null}
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

/** The limits each business hit (20261027023100): what each is, what can be done, and that it clears itself. */
function LimitsCard({ limits }: { limits: Groups['limits'] }) {
  const w = DESK_PROBLEM_SECTION_WORDS;
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="problems-limits">
      <Text className="text-[15px] font-semibold">{w.limits}</Text>
      <Text className="text-[13px] leading-[18px] text-text-3">{w.limitsIntro}</Text>
      {limits.length === 0 ? (
        <Text className="text-[13.5px] text-text-3">{w.noLimits}</Text>
      ) : (
        limits.map((g) => (
          <View
            key={`${g.workspaceId}:${g.limitKind}:${g.area ?? ''}`}
            className="mt-1 gap-0.5 rounded-menu bg-warning-soft px-3 py-2.5"
            testID={`problems-limit-${g.limitKind}`}
          >
            <Text className="text-[14px] font-semibold text-warning-text">{w.limitTitle(g)}</Text>
            <Text className="text-[12.5px] text-text-3">
              {w.limitCounts(g, whenWords(g.firstAt), whenWords(g.lastAt))}
            </Text>
            <Text className="text-[13.5px] leading-[19px] text-text-2">{w.limitSaid(g)}</Text>
          </View>
        ))
      )}
    </Card>
  );
}

/** What needs a fix, by problem (20261027023100): each opens to its step's reports. */
function FixesCard({
  fixes,
  onPick,
}: {
  fixes: Groups['fixes'];
  onPick: (picked: Picked) => void;
}) {
  const w = DESK_PROBLEM_SECTION_WORDS;
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="problems-fixes">
      <Text className="text-[15px] font-semibold">{w.fixes}</Text>
      <Text className="text-[13px] leading-[18px] text-text-3">{w.fixesIntro}</Text>
      {fixes.length === 0 ? (
        <Text className="text-[13.5px] text-text-3">{w.noFixes}</Text>
      ) : (
        fixes.map((g) => {
          const helper = w.fixHelper(g);
          return (
            <Pressable
              key={`${g.area}:${g.job}:${g.note ?? ''}`}
              role="button"
              onPress={() => onPick({ area: g.area, job: g.job })}
              className="mt-1 gap-0.5 rounded-menu border border-border px-3 py-2.5 active:bg-card-2"
              testID={`problems-fix-${g.area}-${g.job}`}
            >
              <Text className="text-[14px] font-semibold">{w.fixTitle(g)}</Text>
              <Text className="text-[12.5px] text-text-3">
                {w.fixCounts(g, whenWords(g.lastAt))}
              </Text>
              <Text className="text-[13.5px] leading-[19px] text-text-2">
                {g.note ?? DESK_PROBLEM_WORDS.noNote}
              </Text>
              {helper ? <Text className="text-[12.5px] text-text-3">{helper}</Text> : null}
            </Pressable>
          );
        })
      )}
    </Card>
  );
}

/** The last week's reports by step, and how the AI helper sorted them (decision 142). */
function StepsCard({ steps }: { steps: Steps }) {
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="problems-steps">
      <Text className="text-[15px] font-semibold">{DESK_HELPER_WORDS.steps}</Text>
      {steps.length === 0 ? (
        <Text className="text-[13.5px] text-text-3">{DESK_HELPER_WORDS.noSteps}</Text>
      ) : (
        steps.slice(0, 8).map((t) => (
          <Text key={`${t.area}:${t.job}`} className="text-[13.5px] leading-[19px] text-text-2">
            <Text className="text-[13.5px] font-medium">
              {t.area} · {t.job}
            </Text>
            {`  ${DESK_HELPER_WORDS.step(t)}`}
          </Text>
        ))
      )}
    </Card>
  );
}

/**
 * The report a Needs you step's See what it saw opened (decision 142): what the tool said, what the AI helper found
 * and did, and sharing it for Claude.
 */
function OpenedReport({ reportId }: { reportId: string }) {
  const live = useLive(
    () => desk('/v1/queries/platform.problem_report.get', { reportId }),
    `problem-${reportId}`,
  );
  const r: ProblemReportFull | null = live.data;
  if (!r) return <DeskWaiting live={live} testID="problem-opened" />;
  const h = r.helper;
  return (
    <Card className="gap-1.5 px-4 py-3.5" testID="problem-opened">
      <Text className="text-[15px] font-semibold">{problemWhere(r)}</Text>
      <Text className="text-[13px] text-text-3">
        {r.business} · {whenWords(r.at)} · {problemFrom(r)}
      </Text>
      <Text selectable className="text-[13.5px] leading-[19px] text-text-2">
        {r.note ?? DESK_PROBLEM_WORDS.noNote}
      </Text>
      {h ? (
        <View className="mt-1 gap-1" testID="problem-opened-helper">
          <Text className="text-[14px] font-semibold">{DESK_HELPER_WORDS.heading}</Text>
          <Text className="text-[13.5px] font-medium">
            {HELPER_VERDICT_WORDS[h.verdict]} · {HELPER_RESULT_WORDS[h.result]}
          </Text>
          <Text selectable className="text-[13.5px] leading-[19px] text-text-2">
            {h.looks === 0 && !h.learned
              ? DESK_HELPER_WORDS.notAsked
              : h.said || DESK_HELPER_WORDS.nothingSaid}
          </Text>
          {h.learned ? (
            <Text className="text-[13px] text-text-2">{DESK_HELPER_WORDS.learned[h.learned]}</Text>
          ) : null}
          {h.moves.length === 0 ? (
            <Text className="text-[13px] text-text-3">{DESK_HELPER_WORDS.noMoves}</Text>
          ) : (
            h.moves.map((m, i) => (
              <Text key={i} className="text-[13px] text-text-2">
                {`${i + 1}. ${helperMoveWords(m)}`}
              </Text>
            ))
          )}
        </View>
      ) : null}
      <View className="mt-1 flex-row flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onPress={() =>
            void Share.share({ message: problemForClaude(r) }).catch((e: unknown) =>
              toast.error(errorMessage(e)),
            )
          }
          testID="problem-opened-share"
        >
          <Text>{DESK_PROBLEM_WORDS.shareForClaude}</Text>
        </Button>
      </View>
    </Card>
  );
}
