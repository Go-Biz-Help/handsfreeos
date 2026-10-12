import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  dayWords,
  isOffline,
  offlineWords,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
  type LiveDay,
} from '@hfos/core/addons/outreach/live';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { View } from 'react-native';

import { Pause, Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { OutreachFrame } from './frame';
import {
  isSetUp,
  NeedsSignal,
  Note,
  openOutreach,
  Part,
  QueuedNote,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';
import type { LiveBody } from './live';
import { useLiveProps } from './live';
import { TodayBody, useTodayProps } from './today';
import { useWaitingProps, WaitingBody } from './waiting';

/**
 * Social Outreach's Today on the phone (decision 59), as the web's: what the person's computer is doing with Start my
 * day and Stop for today in a strip, then everything that needs them (Needs you, which works with no signal), then
 * their list for the day. A message waiting for an OK shows once, under Needs you. Until the person has set Social
 * Outreach up (decision 45), it says to do that on a computer.
 */
export function TodayHub() {
  const ctx = useOutreachContext();
  const live = useLiveProps(false);
  const waiting = useWaitingProps();
  const today = useTodayProps();
  const setup = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.setup', { body: { workspaceId: ctx.workspaceId } }),
      ),
    `setup:${ctx.workspaceId}`,
    W.title,
  );
  const phone = waiting.phone;
  const shownOnce = React.useMemo(
    () => new Set([...phone.replies, ...phone.messages].map((s) => s.sendId)),
    [phone],
  );
  const count =
    phone.kinds.reply.count +
    phone.kinds.message.count +
    (waiting.server
      ? waiting.server.kinds.ask.count +
        waiting.server.kinds.need.count +
        waiting.server.kinds.request.count
      : 0);
  return (
    <OutreachFrame tab="today" testID="outreach-hub">
      {isSetUp(setup.data) ? null : (
        <Card className="px-4 py-3.5" testID="outreach-set-up-on-computer">
          <Note>{SETUP_WORDS.onPhone}</Note>
        </Card>
      )}
      <LiveStrip {...live} onDetails={() => openOutreach(ctx.workspaceId, 'live')} />
      <Part
        title={count ? `${W.needsYou} · ${count.toLocaleString('en-US')}` : W.needsYou}
        testID="today-needs-you"
      >
        <WaitingBody {...waiting} embedded />
      </Part>
      <Part title={W.listTitle} testID="today-list">
        <TodayBody {...today} embedded hideSends={shownOnce} />
      </Part>
    </OutreachFrame>
  );
}

const DOT = {
  good: 'bg-success',
  waiting: 'bg-accent',
  warn: 'bg-warning',
  plain: 'bg-text-3',
} as const;

/**
 * The computer in a few lines: its state, what it's doing or when it was last seen, the next step, today's steps
 * against the limits, and Start my day or Stop for today. Details opens the live screen.
 */
export function LiveStrip({
  live,
  error,
  online,
  now,
  pressed,
  onRetry,
  onStart,
  onStop,
  onSettings,
  onDetails,
}: Pick<
  React.ComponentProps<typeof LiveBody>,
  'live' | 'error' | 'online' | 'now' | 'pressed' | 'onRetry' | 'onStart' | 'onStop' | 'onSettings'
> & { onDetails: () => void }) {
  if (!live)
    return error ? (
      <NeedsSignal words={error} onRetry={onRetry} testID="today-status-signal" />
    ) : null;
  const tz = live.timezone;
  const day: LiveDay = pressed
    ? { ...live.day, state: pressed, why: 'person', via: 'mobile', at: new Date(now).toISOString() }
    : live.day;
  const computer = live.computer;
  const state = shownState({
    computer: computer ? { state: computer.state, lastSeenAt: computer.lastSeenAt } : null,
    day,
    sending: live.sending,
    now,
  });
  const offline = computer !== null && isOffline(computer.lastSeenAt, now);
  const steps = DAILY_STEPS.filter((s) => live.limits[s].most > 0);
  const said = dayWords(day, tz);
  return (
    <Card className="gap-3 px-4 py-3.5" testID="today-status">
      <View className="flex-row items-center gap-3">
        <View className={cn('size-2.5 rounded-full', DOT[stateTone(state)])} />
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-semibold" testID="live-state">
            {SHOWN_STATES[state]}
          </Text>
          <Text className="text-[13px] leading-[18px] text-text-2" numberOfLines={2}>
            {computer
              ? offline
                ? offlineWords(computer.lastSeenAt, tz, now)
                : (live.status?.line ??
                  W.onComputer(computer.name, seenWords(computer.lastSeenAt, tz, now)))
              : W.noComputer}
          </Text>
        </View>
      </View>
      {computer && live.status?.nextAt && state === 'waiting' ? (
        <Note testID="live-next">{W.nextStep(seenWords(live.status.nextAt, tz, now))}</Note>
      ) : null}
      {steps.length ? (
        <View className="flex-row flex-wrap gap-y-3" testID="today-limits">
          {steps.map((step) => {
            const { done, most } = live.limits[step];
            const full = done >= most;
            return (
              <View key={step} className="w-1/3 gap-1 pr-3" testID={`today-limit-${step}`}>
                <Text className="text-[12px] text-text-2" numberOfLines={1}>
                  {DAILY_WORDS[step].label}
                </Text>
                <View className="h-1 rounded-full bg-card-2">
                  <View
                    className={cn('h-1 rounded-full', full ? 'bg-warning' : 'bg-accent')}
                    style={{ width: `${Math.min(100, Math.round((done / most) * 100))}%` }}
                  />
                </View>
                <Text
                  className={cn(
                    'text-[12px] font-medium',
                    full ? 'text-warning-text' : 'text-text',
                  )}
                >
                  {done.toLocaleString('en-US')} / {most.toLocaleString('en-US')}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {live.warning ? (
        <Text className="text-[13px] leading-[18px] text-danger" testID="live-warning">
          {warningNote(live.warning, now)}
        </Text>
      ) : null}
      {live.sending === 'off' ? (
        <View className="gap-2">
          <Note testID="live-sending-off">{W.sendingOff(live.canSend)}</Note>
          {live.canSend ? (
            <Button variant="secondary" size="md" onPress={onSettings} testID="live-settings">
              {W.tabs.settings}
            </Button>
          ) : null}
        </View>
      ) : (
        <View className="flex-row gap-2">
          {day.state === 'started' ? (
            <Button
              className="flex-1"
              variant="secondary"
              icon={Pause}
              onPress={onStop}
              testID="live-stop"
            >
              {W.stopDay}
            </Button>
          ) : (
            <Button
              className="flex-1"
              variant="secondary"
              icon={Play}
              disabled={live.day.why === 'warning'}
              onPress={onStart}
              testID="live-start"
            >
              {W.startDay}
            </Button>
          )}
          <Button variant="ghost" onPress={onDetails} testID="today-status-details">
            {W.computerDetails}
          </Button>
        </View>
      )}
      {said ? <Note testID="live-day-words">{said}</Note> : null}
      {pressed ? <QueuedNote online={online} /> : null}
    </Card>
  );
}
