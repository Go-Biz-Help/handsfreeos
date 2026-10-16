import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import { WEEKDAY_WORDS } from '@hfos/core/addons/outreach/automation';
import { seenWords } from '@hfos/core/addons/outreach/live';
import type { Platform } from '@hfos/core/addons/outreach/networks';
import { checkCounts, type AnyProfileItem } from '@hfos/core/addons/outreach/profile-check';
import {
  CALLS_GOAL,
  numbersLines,
  numbersMath,
  numbersVerdict,
  profileWordsOn,
  READY_WORDS as R,
  tickCounts,
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

import { AskButton, useAskActions, useAsks, useDoneReload, type AskActions } from './asks';
import { Note, useOutreachAnswer, useOutreachContext } from './kit';

/**
 * Get ready on the phone (docs/outreach.md, decisions 63 and 64; packages/core/src/addons/outreach/readiness.ts):
 * Today's card while the person isn't ready, as the web's. Their own three are done right here: the profile, read by
 * their computer and checked by the AI (**Read my profile**, then **Put this one in** for a bio), with a tick for what
 * the AI can't see; their messages, the samples written on their computer, to read and OK; and their goal with the
 * math as it changes. The main offer and the playbooks are written on a computer. It needs signal.
 *
 * The profile is the network's own (`readiness.platform`): LinkedIn's has its own list in its words, headlines to put
 * in, and an About to start from (selectable, to copy), each asked and ticked on LinkedIn.
 */

const failed = (e: unknown) => toast.error(e instanceof ChangeError ? e.message : errorMessage(e));

/** The items done right here: the rest are on a computer. */
const MINE = ['profile', 'messages', 'numbers'] as const;
type Mine = (typeof MINE)[number];

/** Monday first, as the working week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;

const STATE_ICON = {
  done: { icon: CircleCheck, className: 'text-success' },
  todo: { icon: Circle, className: 'text-text-3' },
  look_again: { icon: RefreshCw, className: 'text-warning' },
  waiting: { icon: Clock, className: 'text-warning' },
} satisfies Record<ReadyState, unknown>;

/**
 * Get ready's answer on a network and what its buttons do: its own profile counts. `onReady` runs once the person is
 * ready there, for Today's list to come back.
 */
export function useReadyProps(
  platform: Platform,
  onReady: () => void,
): React.ComponentProps<typeof GetReadyCard> {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const ready = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.readiness', { body: { workspaceId: ws, platform } }),
      ),
    `readiness:${ws}:${platform}`,
    R.card,
  );
  const [shown, setShown] = React.useState<ReadinessOutput | null>(null);
  // Another network's answer, once shown, isn't this one's.
  React.useEffect(() => setShown(null), [platform]);
  const readiness = shown ?? ready.data;
  const took = (next: ReadinessOutput) => setShown(next);
  // Ready now, from a tick, the goal, or a profile read on the computer: Today's list comes back.
  const isReady = readiness?.ready ?? null;
  const wasReady = React.useRef(isReady);
  React.useEffect(() => {
    if (wasReady.current === false && isReady === true) onReady();
    wasReady.current = isReady;
  }, [isReady, onReady]);
  // The profile read and checked, or a bio put in, on the person's computer: once that ask is done, it shows here.
  const asks = useAsks('today', R.card, readiness !== null && !readiness.ready);
  const actions = useAskActions(asks.data, asks.reload);
  const { reload } = ready;
  const again = React.useCallback(() => {
    setShown(null);
    reload();
  }, [reload]);
  useDoneReload(asks.data, again);
  return {
    readiness,
    asks: asks.data,
    actions,
    onTick: async (item, done) => {
      try {
        took(
          (await change('outreach.readiness.profile', { workspaceId: ws, platform, item, done }))
            .output,
        );
      } catch (e) {
        failed(e);
      }
    },
    onMessages: async () => {
      try {
        took((await change('outreach.readiness.messages', { workspaceId: ws })).output);
        toast.show(R.messages.okd);
        return true;
      } catch (e) {
        failed(e);
        return false;
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
  asks = null,
  actions = null,
  onTick,
  onMessages,
  onNumbers,
}: {
  readiness: ReadinessOutput | null;
  /** What was asked of the person's computer, for Read my profile and Put this one in; null hides those buttons. */
  asks?: AsksOutput | null;
  actions?: AskActions | null;
  onTick: (item: AnyProfileItem, done: boolean) => Promise<void>;
  /** They read right: OKs the samples against the live version. Left out where they can't be OK'd. */
  onMessages?: () => Promise<boolean>;
  onNumbers: (goal: number, days: number[]) => Promise<boolean>;
}) {
  const [open, setOpen] = React.useState<Mine | null>(null);
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
        const mine = MINE.includes(i.item as Mine);
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
              {(i.item === 'profile' || i.item === 'messages') &&
              i.state === 'look_again' &&
              readiness.changed.length ? (
                <Note>{R.changed(readiness.changed)}</Note>
              ) : null}
              {mine && i.state !== 'done' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-3 self-start"
                  onPress={() => setOpen((o) => (o === i.item ? null : (i.item as Mine)))}
                  testID={`ready-open-${i.item}`}
                >
                  {R.items[i.item].go}
                </Button>
              ) : null}
              {open === 'profile' && i.item === 'profile' ? (
                <ProfileList readiness={readiness} asks={asks} actions={actions} onTick={onTick} />
              ) : null}
              {open === 'messages' && i.item === 'messages' ? (
                <MessagesList
                  readiness={readiness}
                  onOk={
                    onMessages
                      ? async () => {
                          if (await onMessages()) setOpen(null);
                        }
                      : null
                  }
                />
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

/**
 * Your messages: the samples the AI wrote on the person's computer, as they'd read in Messenger, to OK. Writing them
 * asks the AI, which the phone doesn't: with none for the live version, it says where.
 */
function MessagesList({
  readiness,
  onOk,
}: {
  readiness: ReadinessOutput;
  onOk: (() => Promise<void>) | null;
}) {
  const M = R.messages;
  const [busy, setBusy] = React.useState(false);
  const samples = readiness.messages.samples;
  const live = readiness.offer?.version ?? null;
  const fresh = samples !== null && live !== null && samples.version === live;
  const bubble = (text: string, key?: string) => (
    <Text
      key={key}
      selectable
      className="max-w-[92%] self-start rounded-[14px] bg-accent-soft px-3 py-2 text-[14px] leading-[20px]"
      testID="ready-message-sample"
    >
      {text}
    </Text>
  );
  const part = (title: string, children: React.ReactNode) => (
    <View className="gap-1.5">
      <Text className="text-[14px] font-semibold">{title}</Text>
      {children}
    </View>
  );
  return (
    <View className="mt-1 gap-3" testID="ready-messages-list">
      {!samples ? <Note>{M.onComputer}</Note> : null}
      {samples && !fresh ? <Note>{`${M.older} ${M.onComputer}`}</Note> : null}
      {samples ? (
        <>
          <Note>{M.about(samples.playbookName, samples.version)}</Note>
          {part(
            M.first,
            samples.first.map((t) => bubble(t, t)),
          )}
          {part(M.video, samples.video ? bubble(samples.video) : <Note>{M.noVideo}</Note>)}
          {samples.link ? part(M.link, bubble(samples.link)) : null}
          {samples.followUps.length
            ? part(
                M.followUps(samples.followUps.length),
                samples.followUps.map((t, i) => (
                  <View key={t} className="gap-0.5">
                    <Text className="text-[12px] text-text-3">
                      {M.later(samples.followUpGaps[i] ?? 1)}
                    </Text>
                    {bubble(t)}
                  </View>
                )),
              )
            : null}
          {samples.checkIn ? part(M.checkIn, bubble(samples.checkIn)) : null}
        </>
      ) : null}
      {fresh && onOk ? (
        <Button
          size="md"
          className="self-start"
          loading={busy}
          onPress={async () => {
            setBusy(true);
            try {
              await onOk();
            } finally {
              setBusy(false);
            }
          }}
          testID="ready-messages-ok"
        >
          {M.ok}
        </Button>
      ) : null}
    </View>
  );
}

function ProfileList({
  readiness,
  asks,
  actions,
  onTick,
}: {
  readiness: ReadinessOutput;
  asks: AsksOutput | null;
  actions: AskActions | null;
  onTick: (item: AnyProfileItem, done: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = React.useState<AnyProfileItem | null>(null);
  // The network's own profile: its list, its words, and its asks.
  const platform = readiness.platform ?? 'facebook';
  const P = profileWordsOn(platform);
  const live = readiness.offer?.version ?? null;
  // The AI's check, when it's of the live version: what's right, and what to change.
  const check = checkCounts(readiness.profileCheck, live) ? readiness.profileCheck : null;
  const timeZone = asks?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <View className="mt-1 gap-3" testID="ready-profile-list">
      <View className="gap-2 rounded-menu bg-card-2 px-3 py-2.5" testID="ready-profile-read">
        <Text className="text-[13px] leading-[18px] text-text-2">
          {check ? P.readAt(seenWords(check.at, timeZone, Date.now())) : P.notRead}
        </Text>
        {asks && actions ? (
          <AskButton
            asks={asks}
            ask={{ kind: 'profile_read' }}
            platform={platform}
            label={check ? P.readAgain : P.read}
            variant={check ? 'secondary' : 'primary'}
            actions={actions}
            testID="ready-profile-read-ask"
          />
        ) : null}
      </View>
      <View className="gap-1">
        {P.items.map((words) => {
          const { item } = words;
          const checked = tickCounts(readiness.profile[item], live);
          const ai = check?.items[item] ?? null;
          const said = ai ? (
            <Text
              className={cn(
                'text-[13px] leading-[18px]',
                ai.ok ? 'text-success-text' : 'text-warning-text',
              )}
            >
              <Text className="text-[13px] font-medium">{ai.ok ? P.ok : P.fix}:</Text>{' '}
              {ai.ok ? ai.why : (ai.fix ?? ai.why)}
            </Text>
          ) : (
            <Note>{words.tip}</Note>
          );
          // Right by the AI's check: nothing to tick.
          if (ai?.ok && !checked)
            return (
              <View
                key={item}
                className="min-h-11 flex-row gap-3 py-2"
                testID={`ready-profile-${item}-ok`}
              >
                <Icon
                  as={CircleCheck}
                  className="mt-0.5 size-5 text-success"
                  accessibilityLabel={P.ok}
                />
                <View className="min-w-0 flex-1">
                  <Text className="text-[14px] font-medium">{words.label}</Text>
                  {said}
                </View>
              </View>
            );
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
                {said}
              </View>
            </Pressable>
          );
        })}
      </View>
      {check?.bios.length ? (
        <View className="gap-2" testID="ready-bios">
          <View className="gap-0.5">
            <Text className="text-[14px] font-semibold">{P.bios}</Text>
            <Note>{P.biosHint}</Note>
          </View>
          {check.bios.map((bio, i) => (
            <View key={bio} className="gap-2 rounded-menu border border-border px-3 py-2.5">
              <Text selectable className="text-[14px] leading-[20px]">
                “{bio}”
              </Text>
              {asks && actions ? (
                <AskButton
                  asks={asks}
                  ask={{ kind: 'profile_edit', bio }}
                  platform={platform}
                  label={P.useBio}
                  actions={actions}
                  testID={`ready-bio-use-${i}`}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {check?.coverLine ? (
        <View className="gap-1" testID="ready-cover-line">
          <Text className="text-[14px] font-semibold">{P.coverLine}</Text>
          <Text selectable className="text-[14px] leading-[20px]">
            “{check.coverLine}”
          </Text>
          <Note>{P.coverHint}</Note>
        </View>
      ) : null}
      {check?.aboutDraft && P.about ? (
        <View className="gap-1" testID="ready-about">
          <Text className="text-[14px] font-semibold">{P.about}</Text>
          <Note>{P.aboutHint}</Note>
          <Text
            selectable
            className="rounded-menu border border-border px-3 py-2.5 text-[14px] leading-[20px]"
          >
            {check.aboutDraft}
          </Text>
        </View>
      ) : null}
      {check?.feature.length ? (
        <View className="gap-1" testID="ready-feature">
          <Text className="text-[14px] font-semibold">{P.feature}</Text>
          {check.feature.map((f) => (
            <Text key={f} className="text-[13.5px] leading-[19px]">
              • {f}
            </Text>
          ))}
        </View>
      ) : null}
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
