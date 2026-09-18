import {
  leadCardWhen,
  money,
  moveChoices,
  moveSheetSubtitle,
  moveSheetTitle,
  PIPELINE_WORDS,
  stageTotals,
  type LeadCard,
  type MoveChoice,
  type StageRef,
} from '@hfos/core';
import * as React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Clock, TriangleAlert } from '@/components/icons';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Input } from '@/components/ui/input';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

/**
 * The pipeline on a phone, as `design/m10/Pipeline.dc.html` draws it: the board can't fit, so it becomes one stage at
 * a time with chips along the top. Nobody drags on a phone — a lead moves with "Move to…", which works with no signal.
 */

export function StageChips({
  stages,
  stageId,
  onChange,
}: {
  stages: readonly { readonly id: string; readonly name: string; readonly count: number }[];
  stageId: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerClassName="gap-1.5 px-0.5"
      testID="stage-chips"
    >
      {stages.map((s) => {
        const on = s.id === stageId;
        return (
          <Pressable
            key={s.id}
            role="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(s.id)}
            className={cn(
              'min-h-11 flex-row items-center gap-2 rounded-full px-3.5',
              on ? 'bg-accent' : 'border border-border-strong bg-card',
            )}
            testID={`stage-chip-${s.name}`}
          >
            <Text className={cn('text-[13px] font-medium', on ? 'text-white' : 'text-text')}>
              {s.name}
            </Text>
            <Text className={cn('text-[12px]', on ? 'text-white/80' : 'text-text-3')}>
              {s.count}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** "4 leads · $21,850" under the chips. */
export function StageTotals({ count, valueCents }: { count: number; valueCents: number }) {
  return (
    <Text className="px-1 text-[13px] text-text-2" testID="stage-totals">
      {stageTotals(count, valueCents)}
    </Text>
  );
}

export function LeadCardView({
  lead,
  nextAction,
  now,
  onPress,
}: {
  lead: LeadCard;
  /** The task or next action under the card: "Order the attic insulation · Fri". */
  nextAction: string | null;
  now: number;
  onPress: (id: string) => void;
}) {
  const who = lead.person?.fullName ?? lead.company?.name ?? '';
  return (
    <Pressable
      role="button"
      onPress={() => onPress(lead.id)}
      className="gap-2 rounded-menu border border-border bg-card p-3"
      testID={`lead-card-${lead.id}`}
    >
      <View className="flex-row items-start justify-between gap-2">
        <Text
          className="min-w-0 flex-1 text-[15px] font-semibold leading-tight"
          testID="lead-title"
        >
          {lead.title}
        </Text>
        <Text className="flex-none text-[14px] font-semibold">{money(lead.valueCents)}</Text>
      </View>
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-[13px] text-text-2" numberOfLines={1}>
          {who}
        </Text>
        {lead.assignee ? (
          <Avatar name={lead.assignee.fullName} seed={lead.assignee.id} size="sm" />
        ) : null}
      </View>
      <Text className="text-[12px] text-text-3">
        {leadCardWhen(lead.source, lead.stageEnteredAt, now)}
      </Text>
      {lead.status === 'open' ? (
        nextAction ? (
          <View className="flex-row items-center gap-1.5">
            {lead.nextActionOverdue ? (
              <View
                className="size-2 rounded-full bg-danger"
                accessibilityLabel="Next action is overdue"
                testID="lead-overdue-dot"
              />
            ) : (
              <Icon as={Clock} className="size-3.5 text-accent-text" />
            )}
            <Text className="min-w-0 flex-1 text-[12.5px] text-accent-text" numberOfLines={1}>
              {nextAction}
            </Text>
          </View>
        ) : (
          <View className="flex-row items-center gap-1.5">
            <Icon as={TriangleAlert} className="size-3.5 text-warning-text" />
            <Text className="text-[12.5px] font-medium text-warning-text" testID="lead-no-next">
              {PIPELINE_WORDS.noNextAction}
            </Text>
          </View>
        )
      ) : null}
    </Pressable>
  );
}

/** Move to…: every stage of this lead's pipeline, with what the unusual ones do, and the offline promise. */
export function MoveSheet({
  open,
  lead,
  stages,
  pipelineName,
  onClose,
  onMove,
}: {
  open: boolean;
  lead: LeadCard | null;
  stages: readonly StageRef[];
  pipelineName: string;
  onClose: () => void;
  onMove: (stage: StageRef) => void;
}) {
  if (!lead) return null;
  const choices: readonly MoveChoice[] = moveChoices(stages, lead.stageId);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={moveSheetTitle(lead.title)}
      description={moveSheetSubtitle(
        lead.person?.fullName ?? lead.company?.name ?? null,
        lead.valueCents,
        pipelineName,
      )}
      testID="move-sheet"
    >
      <View className="gap-1">
        {choices.map((c) => (
          <Pressable
            key={c.id}
            role="button"
            disabled={c.current}
            onPress={() => onMove(stages.find((s) => s.id === c.id)!)}
            className={cn(
              'min-h-14 flex-row items-center gap-3 rounded-menu px-3',
              c.current && 'bg-card-2',
            )}
            testID={`move-to-${c.name}`}
          >
            <Text className="min-w-0 flex-1 text-[15px]">{c.name}</Text>
            {c.note ? <Text className="text-[12.5px] text-text-3">{c.note}</Text> : null}
          </Pressable>
        ))}
        <Text className="px-3 pt-2 text-[12.5px] text-text-3">{PIPELINE_WORDS.moveOffline}</Text>
        <Button variant="secondary" onPress={onClose} className="mt-2" testID="move-cancel">
          {PIPELINE_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

/** Lost asks why, exactly as the web does. */
export const LOST_REASONS = [
  { title: 'Went with another bidder', extra: 'Price or timing' },
  { title: 'Decided not to do the work', extra: 'Postponed or cancelled' },
  { title: 'No response', extra: 'Went cold after follow-ups' },
] as const;

export function LostSheet({
  open,
  leadTitle,
  onClose,
  onConfirm,
}: {
  open: boolean;
  leadTitle: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Why was it lost?"
      description={leadTitle}
      testID="lost-sheet"
    >
      <View className="gap-1">
        {LOST_REASONS.map((r) => (
          <Pressable
            key={r.title}
            role="button"
            onPress={() => onConfirm(`${r.title} · ${r.extra}`)}
            className="min-h-14 justify-center gap-0.5 rounded-menu px-3"
            testID={`lost-${r.title}`}
          >
            <Text className="text-[15px]">{r.title}</Text>
            <Text className="text-[12.5px] text-text-3">{r.extra}</Text>
          </Pressable>
        ))}
        <Button variant="secondary" onPress={onClose} className="mt-2">
          {PIPELINE_WORDS.cancel}
        </Button>
      </View>
    </Sheet>
  );
}

/** The next action on a lead's page: what it is, or the box that asks for one (the canvas's "Set"). */
export function NextActionBox({
  lead,
  onSet,
}: {
  lead: LeadCard;
  onSet: (text: string) => void | Promise<void>;
}) {
  const [text, setText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (lead.nextAction)
    return (
      <View
        className="flex-row items-center gap-2 rounded-menu bg-accent-soft px-3.5 py-3"
        testID="lead-next-action"
      >
        <Icon as={Clock} className="size-4 text-accent-text" />
        <Text className="min-w-0 flex-1 text-[13.5px] text-accent-text">
          <Text className="font-semibold text-accent-text">{PIPELINE_WORDS.nextPrefix}</Text>{' '}
          {lead.nextAction}
        </Text>
      </View>
    );
  return (
    <View className="gap-2 rounded-menu bg-warning-soft px-3.5 py-3" testID="lead-next-action-none">
      <Text className="text-[13.5px] font-semibold text-warning-text">
        {PIPELINE_WORDS.noNextAction}
      </Text>
      <Text className="text-[13px] text-warning-text">{PIPELINE_WORDS.sayWhatHappens}</Text>
      <View className="flex-row gap-2">
        <Input
          value={text}
          onChangeText={setText}
          placeholder={PIPELINE_WORDS.nextActionPlaceholder}
          className="min-w-0 flex-1 bg-card"
          testID="lead-next-input"
        />
        <Button
          size="md"
          disabled={!text.trim()}
          loading={busy}
          onPress={() => {
            if (!text.trim()) return;
            setBusy(true);
            void Promise.resolve(onSet(text.trim())).finally(() => {
              setBusy(false);
              setText('');
            });
          }}
          testID="lead-next-set"
        >
          {PIPELINE_WORDS.set}
        </Button>
      </View>
    </View>
  );
}

/** The stage a lead is in, as a square badge so it never reads as a tag. */
export function StageBadge({ name, kind }: { name: string; kind: 'open' | 'won' | 'lost' }) {
  return (
    <View
      className={cn(
        'h-[22px] justify-center rounded-[6px] px-2',
        kind === 'won' ? 'bg-success-soft' : kind === 'lost' ? 'bg-danger-soft' : 'bg-accent-soft',
      )}
    >
      <Text
        testID="stage-badge"
        className={cn(
          'text-xs font-medium',
          kind === 'won'
            ? 'text-success-text'
            : kind === 'lost'
              ? 'text-danger-text'
              : 'text-accent-text',
        )}
      >
        {name}
      </Text>
    </View>
  );
}

/** The card's empty stage. */
export function StageEmpty({ name }: { name: string }) {
  return (
    <Card className="items-center px-4 py-8" testID="stage-empty">
      <Text className="text-[13px] text-text-2">{`No leads in ${name}.`}</Text>
    </Card>
  );
}
