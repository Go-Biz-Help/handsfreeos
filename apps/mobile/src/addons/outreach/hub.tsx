import { DAILY_STEPS } from '@hfos/core/addons/outreach/limits';
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
import { askableOn } from '@hfos/core/addons/outreach/asks';
import {
  dailyWordsOn,
  findPostsWordsOn,
  NETWORK_WORDS as NW,
  networkShown,
  noRunnerWords,
} from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, runsOnItsOwn, type Platform } from '@hfos/core/addons/outreach/networks';
import { notReadyWords, READY_WORDS } from '@hfos/core/addons/outreach/readiness';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Pause, Play } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { api, unwrap } from '@/lib/api';
import { cn } from '@/lib/utils';

import { AskButton, useAskActions, useAsks } from './asks';
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
import { StartRefusedNote, useLiveProps } from './live';
import { useNetworksOn } from './networks';
import { PersonMenuScope } from './person-menu';
import { GetReadyCard, useReadyProps } from './ready';
import { TodayBody, useTodayProps } from './today';
import { useWaitingProps, WaitingBody } from './waiting';

/**
 * Social Outreach's Today on the phone (decision 59), as the web's: what the person's computer is doing with Start my
 * day and Stop for today in a strip, then everything that needs them (Needs you, which works with no signal), then
 * their list for the day. A message waiting for an OK shows once, under Needs you. Until the person has set Social
 * Outreach up (decision 45), it says to do that on a computer; until they're ready (decision 63), Get ready shows
 * above the list (./ready.tsx) and Start my day waits, saying beside it what holds the day and where it's done. Their
 * profile never holds it (decision 90): while it's left, Get ready shows it as advice beside a Start that works. A
 * press HandsFreeOS refuses stays beside its Start in HandsFreeOS's words, with **Do it now** where it's fixed
 * (./live.tsx, `startRefusedOf`).
 *
 * Each network on its own (Chris): with more than one network on, the strip is a row for each, by name, with its own
 * day, its own Start my day or Stop for today and its own warning line; the one shown opens in full, and the list
 * below is its own (`outreach.today` with its `platform`). Pressing a network's name shows its list. Get ready is the
 * network shown's, and each other row's Start my day waits on its own readiness (its own playbook counts), with its
 * own words beside it.
 *
 * Every name under Needs you and on the list opens the person menu (decision 91, ./person-menu.tsx); a change there
 * reloads both, so a card that should leave does.
 */
export function TodayHub({ net: start = null }: { net?: Platform | null } = {}) {
  const ctx = useOutreachContext();
  const nets = useNetworksOn();
  // The network an address names (a push about a post there): its list first.
  const [asked, setAsked] = React.useState<Platform | null>(start);
  const net = networkShown(nets, asked);
  const many = nets.length > 1;
  const waiting = useWaitingProps();
  const today = useTodayProps(net);
  // Until the person is ready on the network shown, its Get ready shows above the list; once they are, Today's list
  // and the strip come back.
  const ready = useReadyProps(net, () => today.onRetry());
  const notReady = ready.readiness !== null && !ready.readiness.ready;
  // What holds the day on the network shown, and where it's done: beside its Start my day.
  const held = ready.readiness && notReady ? notReadyWords(ready.readiness) : null;
  const setup = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.setup', { body: { workspaceId: ctx.workspaceId } }),
      ),
    `setup:${ctx.workspaceId}`,
    W.title,
  );
  const reloadWaiting = waiting.onRetry;
  const reloadToday = today.onRetry;
  const reloadBoth = React.useCallback(() => {
    reloadWaiting();
    reloadToday();
  }, [reloadWaiting, reloadToday]);
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
      {nets.map((p) => (
        <NetworkDay
          key={p}
          platform={p}
          many={many}
          shown={p === net}
          ready={!notReady}
          held={held}
          onShow={() => setAsked(p)}
          onDetails={() => openOutreach(ctx.workspaceId, 'live', `net=${p}`)}
        />
      ))}
      <GetReadyCard {...ready} />
      <PersonMenuScope
        workspaceId={ctx.workspaceId}
        online={ctx.online}
        writesContacts={ctx.writesContacts}
        onChanged={reloadBoth}
      >
        <Part
          title={count ? `${W.needsYou} · ${count.toLocaleString('en-US')}` : W.needsYou}
          testID="today-needs-you"
        >
          <WaitingBody {...waiting} embedded />
        </Part>
        <Part title={many ? NW.listOn(PLATFORMS[net]) : W.listTitle} testID="today-list">
          <TodayBody {...today} embedded hideSends={shownOnce} />
        </Part>
      </PersonMenuScope>
      {askableOn(net, 'posts') && !runsOnItsOwn(net) ? <FindPosts platform={net} /> : null}
    </OutreachFrame>
  );
}

/**
 * Find posts, on a network the extension doesn't work on its own: the person asks for it here, and the good ones come
 * onto the list. Where a runner works the network (Alignable's, from part 5), it reads the town's posts once a day
 * itself, so the card doesn't show.
 */
function FindPosts({ platform }: { platform: Platform }) {
  const asks = useAsks(null, W.rows.today);
  const actions = useAskActions(asks.data, asks.reload);
  const words = findPostsWordsOn(platform);
  if (!asks.data) return null;
  return (
    <Card className="gap-2 px-4 py-4" testID="today-find-posts">
      <Text className="text-[15px] font-semibold">{words.title}</Text>
      <Note>{words.body}</Note>
      <AskButton
        asks={asks.data}
        actions={actions}
        ask={{ kind: 'posts' }}
        platform={platform}
        label={words.title}
        testID="today-find-posts-ask"
      />
    </Card>
  );
}

/**
 * One network's row of the strip: its own live answer, and its own Start and Stop. A row not shown asks whether the
 * person is ready there (its own playbook counts, never its profile) and what holds its day; the one shown has Get
 * ready's answer.
 */
function NetworkDay({
  platform,
  ready,
  held,
  ...rest
}: { platform: Platform } & Pick<
  React.ComponentProps<typeof LiveStrip>,
  'many' | 'shown' | 'ready' | 'held' | 'onShow' | 'onDetails'
>) {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const live = useLiveProps(false, platform);
  const own = useOutreachAnswer(
    rest.shown
      ? null
      : async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.readiness', {
              body: { workspaceId: ws, platform },
            }),
          ),
    `ready:${ws}:${platform}`,
    W.title,
  );
  const readyHere = rest.shown ? ready : (own.data?.ready ?? ready);
  // Its own reason, never the shown network's: until its own answer comes, the strip's general line.
  const heldHere = rest.shown ? held : own.data && !own.data.ready ? notReadyWords(own.data) : null;
  return <LiveStrip {...live} platform={platform} {...rest} ready={readyHere} held={heldHere} />;
}

const DOT = {
  good: 'bg-success',
  waiting: 'bg-accent',
  warn: 'bg-warning',
  plain: 'bg-text-3',
} as const;

/**
 * The computer in a few lines: its state, what it's doing or when it was last seen, the next step, today's steps
 * against the limits, and Start my day or Stop for today. Details opens the live screen. With more than one network
 * (`many`), it's one network's row, by name: just its day, its Start or Stop and its warning, unless it's the one
 * shown, which has the rest too.
 */
export function LiveStrip({
  platform = 'facebook',
  live,
  error,
  online,
  now,
  pressed,
  onRetry,
  onStart,
  onStop,
  onSettings,
  onGeneral,
  onDetails,
  refused = null,
  manages = false,
  ready = true,
  many = false,
  shown = true,
  onShow,
  held = null,
}: Pick<
  React.ComponentProps<typeof LiveBody>,
  | 'live'
  | 'error'
  | 'online'
  | 'now'
  | 'pressed'
  | 'refused'
  | 'manages'
  | 'onRetry'
  | 'onStart'
  | 'onStop'
  | 'onSettings'
  | 'onGeneral'
> & {
  /** The network whose day it is. */
  platform?: Platform;
  onDetails: () => void;
  /** Whether the person is ready (decision 63): until they are, Start my day waits and says why. */
  ready?: boolean;
  /** One row of several, each network's own. */
  many?: boolean;
  /** The network shown below: its row has the computer and the limits too. */
  shown?: boolean;
  /** Shows this network's list. */
  onShow?: () => void;
  /** While it isn't ready: what holds its day under Get ready and where it's done (`notReadyWords`). */
  held?: string | null;
}) {
  const name = PLATFORMS[platform];
  if (!live)
    return error ? (
      <NeedsSignal
        words={many ? `${name}: ${error}` : error}
        onRetry={onRetry}
        testID="today-status-signal"
      />
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
  const words = dailyWordsOn(platform);
  const steps = DAILY_STEPS.filter((s) => live.limits[s].most > 0);
  const said = dayWords(day, tz, live.lists, platform);
  const full = !many || shown;
  return (
    <Card
      className={cn('gap-3 px-4 py-3.5', many && shown && 'border-accent')}
      testID={many ? `today-network-${platform}` : 'today-status'}
    >
      {many ? (
        <Pressable
          role="button"
          accessibilityLabel={NW.showList(name)}
          onPress={onShow}
          className="flex-row items-center justify-between gap-2"
          testID={`today-network-${platform}-open`}
        >
          <Text className="text-[15px] font-semibold">{name}</Text>
          <Text className="text-[13px] text-text-2" numberOfLines={1}>
            {said || NW.notStarted}
          </Text>
        </Pressable>
      ) : null}
      {full ? (
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
      ) : null}
      {full && computer && live.status?.nextAt && state === 'waiting' ? (
        <Note testID="live-next">{W.nextStep(seenWords(live.status.nextAt, tz, now))}</Note>
      ) : null}
      {full && steps.length ? (
        <View className="flex-row flex-wrap gap-y-3" testID="today-limits">
          {steps.map((step) => {
            const { done, most } = live.limits[step];
            const filled = done >= most;
            return (
              <View key={step} className="w-1/3 gap-1 pr-3" testID={`today-limit-${step}`}>
                <Text className="text-[12px] text-text-2" numberOfLines={1}>
                  {words[step].label}
                </Text>
                <View className="h-1 rounded-full bg-card-2">
                  <View
                    className={cn('h-1 rounded-full', filled ? 'bg-warning' : 'bg-accent')}
                    style={{ width: `${Math.min(100, Math.round((done / most) * 100))}%` }}
                  />
                </View>
                <Text
                  className={cn(
                    'text-[12px] font-medium',
                    filled ? 'text-warning-text' : 'text-text',
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
          {warningNote(live.warning, now, platform)}
        </Text>
      ) : null}
      {live.sending === 'off' ? (
        <View className="gap-2">
          <Note testID="live-sending-off">
            {runsOnItsOwn(platform) ? W.sendingOff(live.canSend, manages) : noRunnerWords(platform)}
          </Note>
          {live.canSend && full && runsOnItsOwn(platform) ? (
            <Button variant="secondary" size="md" onPress={onSettings} testID="live-settings">
              {W.tabs.settings}
            </Button>
          ) : !live.canSend && manages && full && runsOnItsOwn(platform) && onGeneral ? (
            // The business allows only Off, and this owner or admin can change that, on General.
            <Button variant="secondary" size="md" onPress={onGeneral} testID="live-general">
              {W.settingsGeneral}
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
              disabled={!ready || live.day.why === 'warning'}
              onPress={onStart}
              testID="live-start"
            >
              {W.startDay}
            </Button>
          )}
          {full ? (
            <Button variant="ghost" onPress={onDetails} testID="today-status-details">
              {W.computerDetails}
            </Button>
          ) : null}
        </View>
      )}
      {/* Beside a Start my day that waits on Get ready, on every row: what holds it, and where it's done. */}
      {ready || day.state === 'started' || live.sending === 'off' ? null : (
        <Note testID={many ? `live-not-ready-${platform}` : 'live-not-ready'}>
          {held || READY_WORDS.stripNotReady}
        </Note>
      )}
      {/* A press HandsFreeOS refused: its words, and where it's fixed. */}
      {refused && day.state !== 'started' ? <StartRefusedNote refused={refused} /> : null}
      {said && !many ? <Note testID="live-day-words">{said}</Note> : null}
      {pressed ? <QueuedNote online={online} /> : null}
    </Card>
  );
}
