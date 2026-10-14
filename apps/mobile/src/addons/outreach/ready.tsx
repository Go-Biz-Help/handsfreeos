import { WEEKDAY_WORDS } from '@hfos/core/addons/outreach/automation';
import {
  CALLS_GOAL,
  numbersLines,
  numbersMath,
  numbersVerdict,
  PROFILE_ITEMS,
  READY_WORDS as R,
  tickCounts,
  type ProfileItem,
  type ReadinessOutput,
  type ReadyState,
} from '@hfos/core/addons/outreach/readiness';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { change, ChangeError } from '@/changes';
import { Check, CircleCheck, Circle, Clock, RefreshCw } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { Note, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * Get ready on the phone (docs/outreach.md, decision 63; packages/core/src/addons/outreach/readiness.ts): Today's card
 * while the person isn't ready, as the web's. Their own two are done right here, the profile list to tick and their
 * goal with the math as it changes; the main offer and the playbooks are written on a computer. It needs signal.
 */

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

/** Monday first, as the working week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const STATE_ICON = {
  done: { icon: CircleCheck, className: 'text-success' },
  todo: { icon: Circle, className: 'text-text-3' },
  look_again: { icon: RefreshCw, className: 'text-warning' },
  waiting: { icon: Clock, className: 'text-warning' },
} satisfies Record<ReadyState, unknown>;

/** Get ready's answer and what its buttons do. `onReady` runs once the person is ready, for Today's list to come back. */
export function useReadyProps(onReady: () => void): React.ComponentProps<typeof GetReadyCard> {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const ready = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.readiness', { body: { workspaceId: ws } })),
    `readiness:${ws}`,
    R.card,
  );
  const [shown, setShown] = React.useState<ReadinessOutput | null>(null);
  const readiness = shown ?? ready.data;
  const took = (next: ReadinessOutput) => {
    setShown(next);
    if (next.ready) onReady();
  };
  return {
    readiness,
    onTick: async (item, done) => {
      try {
        took((await change('outreach.readiness.profile', { workspaceId: ws, item, done })).output);
      } catch (e) {
        failed(e);
      }
    },
    onNumbers: async (goal, days) => {
      try {
        took((await change('outreach.readiness.numbers', { workspaceId: ws, goal, days })).output);
        toast.show(R.numbers.saved);
        return true;
      } catch (e) {
        failed(e);
        return false;
      }
    },
  };
}

export function GetReadyCard({
  readiness,
  onTick,
  onNumbers,
}: {
  readiness: ReadinessOutput | null;
  onTick: (item: ProfileItem, done: boolean) => Promise<void>;
  onNumbers: (goal: number, days: number[]) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState<'profile' | 'numbers' | null>(null);
  if (!readiness || readiness.ready) return null;
  const done = readiness.items.filter((i) => i.state === 'done').length;
  const of = readiness.items.length;
  return (
    <Card className="px-0 py-0" testID="get-ready">
      <View className="gap-2.5 px-4 pb-1 pt-4">
        <Text className="text-[11.5px] font-semibold uppercase tracking-[0.5px] text-text-3">
          {R.card}
        </Text>
        <Text className="text-[18px] font-semibold">{R.title}</Text>
        <Note>{R.cardHint(of - done)}</Note>
        <View className="h-1.5 rounded-full bg-card-2">
          <View
            className="h-1.5 rounded-full bg-accent"
            style={{ width: `${Math.round((done / of) * 100)}%` }}
          />
        </View>
      </View>
      {readiness.items.map((i) => {
        const shown = STATE_ICON[i.state];
        const mine = i.item === 'profile' || i.item === 'numbers';
        return (
          <View
            key={i.item}
            className="flex-row gap-3 border-t border-border px-4 py-3.5"
            testID={`ready-${i.item}`}
          >
            <Icon
              as={shown.icon}
              className={cn('mt-0.5 size-[18px]', shown.className)}
              accessibilityLabel={R.states[i.state]}
            />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text className="text-[15px] font-semibold">{R.items[i.item].label}</Text>
              {i.left ? <Note>{i.left}</Note> : null}
              {i.item === 'profile' && i.state === 'look_again' && readiness.changed.length ? (
                <Note>{R.changed(readiness.changed)}</Note>
              ) : null}
              {mine && i.state !== 'done' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 self-start"
                  onPress={() =>
                    setOpen((o) => (o === i.item ? null : (i.item as 'profile' | 'numbers')))
                  }
                  testID={`ready-open-${i.item}`}
                >
                  {R.items[i.item].go}
                </Button>
              ) : null}
              {open === 'profile' && i.item === 'profile' ? (
                <ProfileList readiness={readiness} onTick={onTick} />
              ) : null}
              {open === 'numbers' && i.item === 'numbers' ? (
                <Numbers
                  readiness={readiness}
                  onSave={async (goal, days) => {
                    if (await onNumbers(goal, days)) setOpen(null);
                  }}
                />
              ) : null}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

function ProfileList({
  readiness,
  onTick,
}: {
  readiness: ReadinessOutput;
  onTick: (item: ProfileItem, done: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<ProfileItem | null>(null);
  const live = readiness.offer?.version ?? null;
  return (
    <View className="mt-1 gap-1" testID="ready-profile-list">
      {PROFILE_ITEMS.map((item) => {
        const checked = tickCounts(readiness.profile[item], live);
        const words = R.profile.items[item];
        return (
          <Pressable
            key={item}
            accessibilityRole="checkbox"
            accessibilityState={{ checked, busy: busy === item }}
            accessibilityLabel={words.label}
            disabled={busy !== null}
            onPress={async () => {
              setBusy(item);
              await onTick(item, !checked);
              setBusy(null);
            }}
            className="min-h-11 flex-row gap-3 py-2"
            testID={`ready-profile-${item}`}
          >
            <View
              className={cn(
                'mt-0.5 size-5 items-center justify-center rounded-[6px] border-[1.5px]',
                checked ? 'border-accent bg-accent' : 'border-border-strong bg-card',
              )}
            >
              {checked ? <Icon as={Check} className="size-3.5 text-white" /> : null}
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[14px] font-medium">{words.label}</Text>
              <Note>{words.tip}</Note>
            </View>
          </Pressable>
        );
      })}
      <Note>{R.profile.soon}</Note>
    </View>
  );
}

function Numbers({
  readiness,
  onSave,
}: {
  readiness: ReadinessOutput;
  onSave: (goal: number, days: number[]) => Promise<void>;
}) {
  const [goal, setGoal] = React.useState(readiness.numbers.goal ?? 8);
  const [days, setDays] = React.useState<number[]>(readiness.numbers.days);
  const [busy, setBusy] = React.useState(false);
  const m = numbersMath({ goal, daysAWeek: days.length, canSend: readiness.numbers.canSend });
  const toggle = (d: number) =>
    setDays((now) =>
      now.includes(d) ? (now.length > 1 ? now.filter((x) => x !== d) : now) : [...now, d],
    );
  return (
    <View className="mt-2 gap-4" testID="ready-numbers-form">
      <View className="gap-2">
        <Text className="text-[13px] font-medium">{R.numbers.goal}</Text>
        <View className="flex-row items-center gap-3">
          <Button
            variant="secondary"
            size="md"
            onPress={() => setGoal((g) => Math.max(CALLS_GOAL.min, g - 1))}
            accessibilityLabel={R.numbers.fewer}
            testID="ready-goal-less"
          >
            −
          </Button>
          <Text className="min-w-12 text-center text-[20px] font-semibold" testID="ready-goal">
            {goal}
          </Text>
          <Button
            variant="secondary"
            size="md"
            onPress={() => setGoal((g) => Math.min(CALLS_GOAL.max, g + 1))}
            accessibilityLabel={R.numbers.more}
            testID="ready-goal-more"
          >
            +
          </Button>
        </View>
      </View>
      <View className="gap-2">
        <Text className="text-[13px] font-medium">{R.numbers.days}</Text>
        <View className="flex-row flex-wrap gap-1.5">
          {WEEK.map((d) => {
            const picked = days.includes(d);
            return (
              <Pressable
                key={d}
                accessibilityRole="button"
                accessibilityState={{ selected: picked }}
                onPress={() => toggle(d)}
                className={cn(
                  'h-11 min-w-[48px] items-center justify-center rounded-full border px-2.5',
                  picked ? 'border-accent bg-accent-soft' : 'border-border-strong bg-card',
                )}
                testID={`ready-day-${d}`}
              >
                <Text
                  className={cn(
                    'text-[13px] font-medium',
                    picked ? 'text-accent-text' : 'text-text-2',
                  )}
                >
                  {WEEKDAY_WORDS[d]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {days.includes(0) ? (
          <Text className="text-[12.5px] text-warning-text">{R.numbers.sunday}</Text>
        ) : null}
      </View>
      <View className="gap-2" testID="ready-math">
        <Text className="text-[13px] font-medium">{R.numbers.takes}</Text>
        <Text className="text-[24px] font-semibold">
          {m.messagesADay.low} to {m.messagesADay.high}{' '}
          <Text className="text-[13px] font-normal text-text-2">{R.numbers.messagesADay}</Text>
        </Text>
        <View className="gap-1 rounded-menu bg-card-2 px-3 py-2.5">
          {numbersLines(goal, m).map((l) => (
            <Text key={l} className="text-[13px]">
              {l}
            </Text>
          ))}
        </View>
        <View
          className={cn(
            'rounded-menu p-3',
            m.fits === 'yes' ? 'bg-success-soft' : 'bg-warning-soft',
          )}
          testID="ready-verdict"
        >
          <Text
            className={cn(
              'text-[13px] leading-[18px]',
              m.fits === 'yes' ? 'text-success-text' : 'text-warning-text',
            )}
          >
            {numbersVerdict(m)}
          </Text>
        </View>
        <Note>
          {R.numbers.rates} {R.numbers.notMessages}
        </Note>
      </View>
      <Button
        loading={busy}
        onPress={async () => {
          setBusy(true);
          await onSave(goal, days);
          setBusy(false);
        }}
        testID="ready-numbers-save"
      >
        {R.numbers.save}
      </Button>
    </View>
  );
}
