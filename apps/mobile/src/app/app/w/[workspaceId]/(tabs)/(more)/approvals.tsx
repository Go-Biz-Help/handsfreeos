import {
  aiName,
  approvalCustomerOf,
  approvalDecidedLine,
  APPROVALS_WORDS,
  draftDecidedLine,
  minutesSince,
  progressShort,
  relativeTimeAgo,
  waitingFor,
  type ApprovalFacts,
} from '@hfos/core';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as React from 'react';
import { FlatList, Pressable, View } from 'react-native';

import {
  DraftCard,
  useAiColors,
  useDraftDecision,
  useWaitingDrafts,
  type WaitingDraft,
} from '@/components/drafts';
import { Info } from '@/components/icons';
import { WorkflowApprovalCard } from '@/components/home/approval-card';
import { useBusiness } from '@/components/shell/business-context';
import { Screen } from '@/components/shell/screen';
import { Avatar } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Segmented } from '@/components/ui/segmented';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import type { ApprovalListItem, DraftListItem } from '@/home/api-types';
import { openWebPath } from '@/home/open';
import { useDecidedLately, useWaitingWorkflowApprovals } from '@/home/use-approvals';
import { useNow, useTeammateName, useWorkspaceRow } from '@/home/use-home';

type View_ = 'waiting' | 'decided';
type Filter = 'all' | 'workflows' | 'ai';

type Waiting =
  | { readonly kind: 'workflow'; readonly at: string; readonly a: ApprovalFacts }
  | { readonly kind: 'ai'; readonly at: string; readonly d: WaitingDraft };

type Decided =
  | { readonly kind: 'workflow'; readonly t: number; readonly a: ApprovalListItem }
  | { readonly kind: 'ai'; readonly t: number; readonly d: DraftListItem };

const FILTERS: readonly Filter[] = ['all', 'workflows', 'ai'];

/** Words for the phone only: the Decided view needs signal, since decided approvals don't reach phones. */
const DECIDED_NEEDS_SIGNAL = 'What was decided lately shows when this phone has signal.';

/**
 * Approvals, from More, Home's approval cards, links and notifications (`workflows/approvals`, `?filter=ai`): what
 * waits for this person's yes, from workflows (approval steps) and from the AI teammate (its drafts), with a filter
 * between them when there's a teammate, and the Decided view. As on the web; deciding waits for signal on the phone.
 */
export default function Approvals() {
  const { business } = useBusiness();
  const params = useLocalSearchParams<{ filter?: string }>();
  const now = useNow();
  const [view, setView] = React.useState<View_>('waiting');
  const [filter, setFilter] = React.useState<Filter>(
    FILTERS.find((f) => f === params.filter) ?? 'all',
  );
  React.useEffect(() => {
    const asked = FILTERS.find((f) => f === params.filter);
    if (asked) {
      setFilter(asked);
      setView('waiting');
    }
  }, [params.filter]);
  const [refresh, setRefresh] = React.useState(0);
  useFocusEffect(React.useCallback(() => setRefresh((n) => n + 1), []));

  const flows = useWaitingWorkflowApprovals(now);
  const drafts = useWaitingDrafts();
  const decided = useDecidedLately(refresh);
  const teammate = useTeammateName();
  const workspace = useWorkspaceRow();
  const timeZone = workspace.timezone || business.timezone || 'UTC';

  const openDrafts = drafts.visible;
  const all: Waiting[] = [
    ...flows.map((a) => ({ kind: 'workflow' as const, at: a.createdAt, a })),
    ...openDrafts.map((d) => ({ kind: 'ai' as const, at: d.draft.createdAt, d })),
  ].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  const shown = all.filter(
    (w) => filter === 'all' || (filter === 'ai' ? w.kind === 'ai' : w.kind === 'workflow'),
  );
  const name =
    teammate ?? openDrafts[0]?.draft.teammate.name ?? decided.drafts[0]?.teammate.name ?? null;
  const decidedRows: Decided[] = [
    ...decided.workflows.map((a) => ({
      kind: 'workflow' as const,
      t: Date.parse(a.decidedAt ?? a.createdAt),
      a,
    })),
    ...decided.drafts.map((d) => ({
      kind: 'ai' as const,
      t: Date.parse(d.decidedAt ?? d.createdAt),
      d,
    })),
  ].sort((x, y) => y.t - x.t);
  const training = decided.progress?.status === 'training' ? progressShort(decided.progress) : null;

  return (
    <Screen title="Approvals" leading="back" testID="approvals" scroll={false}>
      <View className="gap-2.5 border-b border-border bg-card px-3.5 py-3">
        <Segmented<View_>
          label="Approvals"
          value={view}
          onChange={setView}
          options={[
            {
              value: 'waiting',
              label: APPROVALS_WORDS.waitingTab(all.length),
              testID: 'approvals-tab-waiting',
            },
            {
              value: 'decided',
              label: APPROVALS_WORDS.decidedTab(
                decided.fetchedAt === null ? 0 : decidedRows.length,
              ),
              testID: 'approvals-tab-decided',
            },
          ]}
        />
        {view === 'waiting' && name ? (
          <View className="flex-row flex-wrap gap-1.5">
            <FilterChip
              on={filter === 'all'}
              onPress={() => setFilter('all')}
              testID="approvals-filter-all"
            >
              {APPROVALS_WORDS.filterAll(all.length)}
            </FilterChip>
            <FilterChip
              on={filter === 'workflows'}
              onPress={() => setFilter('workflows')}
              testID="approvals-filter-workflows"
            >
              {APPROVALS_WORDS.filterWorkflows(flows.length)}
            </FilterChip>
            <FilterChip
              on={filter === 'ai'}
              onPress={() => setFilter('ai')}
              testID="approvals-filter-ai"
            >
              {APPROVALS_WORDS.filterTeammate(name, openDrafts.length)}
            </FilterChip>
          </View>
        ) : null}
      </View>
      {view === 'waiting' ? (
        <FlatList
          data={shown}
          keyExtractor={(w) => (w.kind === 'workflow' ? w.a.id : w.d.draft.id)}
          contentContainerClassName="gap-2.5 p-3 pb-8"
          testID="approvals-list"
          ListHeaderComponent={
            <View className="gap-2.5">
              <Text variant="group" className="px-1">
                {APPROVALS_WORDS.waitingForYou}
              </Text>
              {name && training && openDrafts.length ? (
                <View
                  className="flex-row items-start gap-2 rounded-[9px] bg-card-2 px-[11px] py-[9px]"
                  testID="approvals-training"
                >
                  <Icon as={Info} className="mt-px size-3.5 text-text-2" />
                  <Text className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-text-2">
                    {APPROVALS_WORDS.training(name, training)}
                  </Text>
                </View>
              ) : null}
            </View>
          }
          renderItem={({ item: w }) =>
            w.kind === 'workflow' ? (
              <WorkflowApprovalCard a={w.a} workspaceId={business.id} now={now} />
            ) : (
              <WaitingDraftCard w={w.d} timeZone={timeZone} now={now} progress={training} />
            )
          }
          ListEmptyComponent={
            <Card className="items-center gap-1.5 px-6 py-8" testID="approvals-empty">
              <Text className="text-base font-semibold">{APPROVALS_WORDS.emptyTitle}</Text>
              <Text className="text-center text-[13.5px] leading-[20px] text-text-2">
                {APPROVALS_WORDS.emptyBody(name)}
              </Text>
            </Card>
          }
        />
      ) : (
        <FlatList
          data={decidedRows}
          keyExtractor={(r) => (r.kind === 'workflow' ? r.a.id : r.d.id)}
          contentContainerClassName="p-3 pb-8"
          testID="approvals-decided"
          ListHeaderComponent={
            <View className="mb-2.5 gap-2">
              <Text variant="group" className="px-1">
                {APPROVALS_WORDS.decidedLately}
              </Text>
              {decided.fetchedAt === null || decided.error ? (
                <Text className="px-1 text-[13px] text-text-3" testID="approvals-decided-signal">
                  {decided.error ?? DECIDED_NEEDS_SIGNAL}
                </Text>
              ) : null}
            </View>
          }
          renderItem={({ item: r, index }) => (
            <DecidedRow
              row={r}
              first={index === 0}
              last={index === decidedRows.length - 1}
              now={now}
            />
          )}
          ListEmptyComponent={
            decided.fetchedAt === null ? null : (
              <Card className="items-center gap-1.5 px-6 py-8" testID="approvals-decided-empty">
                <Text className="text-base font-semibold">{APPROVALS_WORDS.decidedEmptyTitle}</Text>
                <Text className="text-center text-[13.5px] text-text-2">
                  {APPROVALS_WORDS.decidedEmptyBody}
                </Text>
              </Card>
            )
          }
        />
      )}
    </Screen>
  );
}

function FilterChip({
  on,
  onPress,
  children,
  testID,
}: {
  on: boolean;
  onPress: () => void;
  children: string;
  testID: string;
}) {
  return (
    <Pressable
      role="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      testID={testID}
      hitSlop={{ top: 6, bottom: 6 }}
      className={cn(
        'h-8 justify-center rounded-full border px-3',
        on ? 'border-accent bg-accent-soft' : 'border-border bg-card',
      )}
    >
      <Text className={cn('text-[13px] font-medium', on ? 'text-accent-text' : 'text-text-2')}>
        {children}
      </Text>
    </Pressable>
  );
}

/** An AI teammate's waiting draft: step 14's card, with the customer at the top and the training under it. */
function WaitingDraftCard({
  w,
  timeZone,
  now,
  progress,
}: {
  w: WaitingDraft;
  timeZone: string;
  now: number;
  progress: string | null;
}) {
  const { business } = useBusiness();
  const who = w.draft.person?.fullName ?? APPROVALS_WORDS.aCustomer;
  const d = useDraftDecision({
    workspaceId: business.id,
    draft: w.draft,
    who: who.split(/\s+/)[0] ?? who,
  });
  return (
    <DraftCard
      d={d}
      timeZone={timeZone}
      now={now}
      testID="approvals-draft"
      header={
        <View className="flex-row items-center gap-2.5">
          <Avatar name={who} seed={w.draft.personId ?? w.draft.id} size="md" />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-[15px] font-semibold">
              {who}
            </Text>
            <Text className="text-xs text-text-3">
              {waitingFor(minutesSince(w.draft.createdAt, now), { capital: true })}
            </Text>
          </View>
        </View>
      }
      footer={
        progress ? <Text className="text-center text-xs text-text-3">{progress}</Text> : undefined
      }
    />
  );
}

function DecidedRow({
  row,
  first,
  last,
  now,
}: {
  row: Decided;
  first: boolean;
  last: boolean;
  now: number;
}) {
  const { business } = useBusiness();
  const ai = useAiColors();
  const frame = cn(
    'flex-row items-center gap-2.5 border-x border-border bg-card px-4 py-2.5',
    first ? 'rounded-t-card border-t' : 'border-t',
    last && 'rounded-b-card border-b',
  );
  if (row.kind === 'ai') {
    const d = row.d;
    const who = d.person?.fullName ?? APPROVALS_WORDS.aCustomer;
    return (
      <View className={frame} testID="decided-draft-row">
        <Avatar name={who} seed={d.person?.id ?? d.id} size="sm" />
        <View className="min-w-0 flex-1 gap-px">
          <Text numberOfLines={1} className="text-[13.5px] font-semibold">
            {who}
          </Text>
          <Text numberOfLines={1} className="text-xs font-medium" style={{ color: ai.text }}>
            {aiName(d.teammate.name)}
          </Text>
          <Text className="text-[13px] text-text-2">{draftDecidedLine(d)}</Text>
        </View>
        <View className="items-end gap-0.5">
          <Text className="text-xs text-text-3">
            {relativeTimeAgo(d.decidedAt ?? d.createdAt, now)}
          </Text>
          {d.conversationId ? (
            <Pressable
              role="link"
              hitSlop={8}
              onPress={() => openWebPath(`/app/w/${business.id}/inbox/${d.conversationId}`)}
            >
              <Text className="text-xs font-medium text-accent-text">
                {APPROVALS_WORDS.conversation}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }
  const a = row.a;
  const who = approvalCustomerOf(a);
  return (
    <View className={frame} testID="decided-row">
      <Avatar name={who} seed={a.person?.id ?? a.id} size="sm" />
      <View className="min-w-0 flex-1 gap-px">
        <Text numberOfLines={1} className="text-[13.5px] font-semibold">
          {who}
        </Text>
        <Text numberOfLines={1} className="text-xs text-text-3">
          {a.workflow.name}
        </Text>
        <Text className="text-[13px] text-text-2">{approvalDecidedLine(a)}</Text>
      </View>
      <View className="items-end gap-0.5">
        <Text className="text-xs text-text-3">
          {relativeTimeAgo(a.decidedAt ?? a.createdAt, now)}
        </Text>
        <Pressable
          role="link"
          hitSlop={8}
          onPress={() => openWebPath(`/app/w/${business.id}/workflows/runs/${a.runId}`)}
        >
          <Text className="text-xs font-medium text-accent-text">{APPROVALS_WORDS.run}</Text>
        </Pressable>
      </View>
    </View>
  );
}
