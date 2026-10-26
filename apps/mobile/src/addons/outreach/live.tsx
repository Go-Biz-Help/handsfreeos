import { isApiErrorBody } from '@hfos/api-client';
import { DAILY_STEPS } from '@hfos/core/addons/outreach/limits';
import {
  clockWords,
  dayWords,
  isOffline,
  LIVE_REFETCH_SECONDS,
  offlineWords,
  preDayNow,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
  type LiveDay,
  type LiveOutput,
  type LiveTeamOutput,
  type ShownState,
} from '@hfos/core/addons/outreach/live';
import { PRE_DAY_TITLE, preDayCount, preDaySteps } from '@hfos/core/addons/outreach/lists';
import {
  dailyWordsOn,
  networkShown,
  noRunnerWords,
  teamWordsOn,
} from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, runsOnItsOwn, type Platform } from '@hfos/core/addons/outreach/networks';
import { notReadyWords, READY_WORDS } from '@hfos/core/addons/outreach/readiness';
import { SETUP_WORDS, startFix } from '@hfos/core/addons/outreach/setup';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import * as React from 'react';
import { View } from 'react-native';

import { ChangeError } from '@/changes';
import { useChange } from '@/changes/hooks';
import type { OutboxRow } from '@/changes/outbox';
import type { ChangeState } from '@/changes/rules';
import { Check, Inbox, LoaderCircle, Pause, Play } from '@/components/icons';
import { List, ListRow } from '@/components/shell/list';
import { Screen } from '@/components/shell/screen';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { api, errorMessage, unwrap } from '@/lib/api';

import { startDay, stopDay } from './actions';
import { AskedPart, useAskActions, useAsks, type AskActions } from './asks';
import {
  NeedsSignal,
  Note,
  openOutreach,
  openSettingsPart,
  Part,
  QueuedNote,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';
import { useNetworksOn } from './networks';

/**
 * The live view on the phone (decision 44): what the person's extension is doing now, asked again every minute while
 * the screen is open (`LIVE_REFETCH_SECONDS`), Start my day and Stop for today, today's counts against the daily
 * limits, what the person asked their computer (decision 43, with **Carry on**, **Skip** and **Stop**), and today's
 * steps; for owners and admins, each person's state. Start and Stop wait on the phone with no
 * signal and go when it's back; the rest needs signal, and with none the last answer stays, "As of" when it came.
 * The day, its warning, its limits and its first lists are one network's (`outreach.live`'s `platform`, Facebook's
 * when left out): Today's strip asks for each network the person works (./hub.tsx).
 *
 * A Start my day that can't be pressed says why beside it (the owner, 26 Oct 2026): what holds the day under Get ready
 * and where it's done, the extension doing nothing on its own with where to change it, or the warning. Start is a
 * change that waits on the phone, so HandsFreeOS's answer comes after the press: "Your day has started" shows only once
 * it's taken, and a refusal stays beside Start in HandsFreeOS's words, with **Do it now** where it's fixed (`startFix`,
 * by its rule and details, never its words).
 */

const TONE_BADGE = { good: 'ok', waiting: 'pending', warn: 'danger', plain: 'gray' } as const;

/** Start or Stop pressed on this phone: which, the change it waits in, and when. */
export interface Press {
  readonly state: 'started' | 'stopped';
  readonly id: string;
  readonly at: number;
}

/** A change still on its way to HandsFreeOS, rather than sent or waiting for the person to answer. */
const ON_THE_WAY: readonly ChangeState[] = ['waiting', 'sending', 'held', 'retry'];

/**
 * Whether the phone still shows a press over HandsFreeOS's answer: only while it waits on the phone to be sent (or
 * the phone hasn't read it back yet and nothing has answered since). Once it's gone, HandsFreeOS's answer shows,
 * whatever it says: a Facebook warning keeps the day stopped, and a newer press elsewhere wins.
 */
export function pressShown(
  press: Press | null,
  change: { readonly state: ChangeState } | null,
  answeredAt: number | null,
): boolean {
  if (!press) return false;
  if (change) return ON_THE_WAY.includes(change.state);
  return (answeredAt ?? 0) <= press.at;
}

/** A press of Start my day HandsFreeOS refused, kept beside the button: its words, and where it's fixed. */
export interface StartRefusedShown {
  readonly words: string;
  /** Opens where it's fixed: null when there's nothing to press (a warning today, or someone else's to do). */
  readonly fix: (() => void) | null;
}

/** The refusal's details, from the answer the phone kept with it: what `startFix` reads. */
function detailsOf(row: Pick<OutboxRow, 'answer'>): unknown {
  try {
    const body: unknown = row.answer ? JSON.parse(row.answer) : null;
    return isApiErrorBody(body) ? body.error.details : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A refused Start my day as the phone shows it: HandsFreeOS's words, and where it's fixed on the phone. The person's
 * choices and the networks they use are on the network's page of Settings; the business's rules on General, or the
 * network's own page for a network the business doesn't use (`outreach.manage` only, as `startFix` decides); and
 * Get ready's items under Get ready on Today, which the strip there already sits over (`onToday` null).
 */
export function startRefusedOf(
  row: Pick<OutboxRow, 'reason' | 'rule' | 'answer'>,
  platform: Platform,
  to: {
    readonly manages: boolean;
    readonly onSettings: (part: 'general' | Platform) => void;
    readonly onToday: (() => void) | null;
  },
): StartRefusedShown {
  const rule = row.rule ?? undefined;
  const stop = startFix({ rule, details: detailsOf(row) }, platform, to.manages);
  const words = row.reason ?? W.startRefused;
  if (!stop) return { words, fix: null };
  switch (stop.step) {
    case 'choices':
    case 'networks':
      return { words, fix: () => to.onSettings(platform) };
    case 'rules':
      return {
        words,
        fix: () => to.onSettings(rule === 'outreach_sending_off' ? 'general' : platform),
      };
    default:
      return { words, fix: to.onToday };
  }
}

/** A refused Start my day, beside the button: HandsFreeOS's words, with Do it now where it's fixed. */
export function StartRefusedNote({ refused }: { refused: StartRefusedShown }) {
  return (
    <View
      className="gap-2 rounded-menu bg-warning-soft px-3 py-2.5"
      accessibilityRole="alert"
      testID="live-start-refused"
    >
      <Text className="text-[13px] leading-[18px] text-warning-text">{refused.words}</Text>
      {refused.fix ? (
        <Button variant="secondary" size="sm" onPress={refused.fix} testID="live-start-fix">
          {SETUP_WORDS.start.doItNow}
        </Button>
      ) : null}
    </View>
  );
}

export function StateChip({ state, testID }: { state: ShownState; testID?: string }) {
  return (
    <Badge variant={TONE_BADGE[stateTone(state)]} testID={testID}>
      <Text>{SHOWN_STATES[state]}</Text>
    </Badge>
  );
}

/**
 * The live screen: the day of the network picked, of those the person works (the one its address names, else their
 * first, to start).
 */
export function LiveScreen({ net: start = null }: { net?: Platform | null }) {
  const nets = useNetworksOn();
  const [asked, setAsked] = React.useState<Platform | null>(start);
  const net = networkShown(nets, asked);
  const ws = useOutreachContext().workspaceId;
  // Get ready on the network shown, as Today's strip has it: Start waits while anything holds the day, saying what.
  const ready = useOutreachAnswer(
    async () =>
      unwrap(
        await api.POST('/v1/queries/outreach.readiness', {
          body: { workspaceId: ws, platform: net },
        }),
      ),
    `ready:${ws}:${net}`,
    W.title,
  );
  return (
    <LiveBody
      {...useLiveProps(true, net)}
      networks={nets}
      onNetwork={setAsked}
      ready={ready.data?.ready ?? true}
      held={ready.data && !ready.data.ready ? notReadyWords(ready.data) : null}
    />
  );
}

/**
 * The live answer on a network, Start and Stop there with what waits on the phone: for its own screen and Today's
 * strip (./hub.tsx), a row for each network.
 */
export function useLiveProps(
  full = true,
  platform: Platform = 'facebook',
): React.ComponentProps<typeof LiveBody> {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const live = useOutreachAnswer(
    async () =>
      unwrap(await api.POST('/v1/queries/outreach.live', { body: { workspaceId: ws, platform } })),
    `live:${ws}:${platform}`,
    W.rows.live,
    { everySeconds: LIVE_REFETCH_SECONDS },
  );
  // The team's only on the live screen itself.
  const team = useOutreachAnswer(
    ctx.manages && full
      ? async () =>
          unwrap(
            await api.POST('/v1/queries/outreach.live.team', {
              body: { workspaceId: ws, platform },
            }),
          )
      : null,
    `live-team:${ws}:${platform}`,
    W.team,
    { everySeconds: LIVE_REFETCH_SECONDS },
  );
  const asks = useAsks(null, W.rows.live);
  const askActions = useAskActions(asks.data, asks.reload);
  // A press waits on the phone with no signal: the day shows as pressed while it waits there, then HandsFreeOS's answer.
  const [pressed, setPressed] = React.useState<Press | null>(null);
  // Only this press's own change: never an earlier one's answer, while the look-up catches up with a new press.
  const row = useChange(pressed?.id ?? '');
  const queued = row && pressed && row.id === pressed.id ? row : null;
  const shown = pressShown(pressed, queued, live.at);
  const sent = queued?.state === 'sent';
  const { reload } = live;
  // A Start HandsFreeOS refused: kept beside the button until the next press, with where it's fixed.
  const [refused, setRefused] = React.useState<StartRefusedShown | null>(null);
  // "Your day has started", said once HandsFreeOS has taken it: a refusal says why instead.
  const announce = React.useRef<string | null>(null);
  const { manages } = ctx;
  React.useEffect(() => {
    if (!pressed || shown) return;
    if (pressed.state === 'started' && queued?.state === 'refused') {
      announce.current = null;
      setRefused(
        startRefusedOf(queued, platform, {
          manages,
          onSettings: (part) => openSettingsPart(ws, part),
          // On Today, Get ready sits under the strip; Details opens Today, where it is.
          onToday: full ? () => openOutreach(ws, 'today', `net=${platform}`) : null,
        }),
      );
    }
    setPressed(null);
  }, [pressed, shown, queued, platform, manages, ws, full]);
  React.useEffect(() => {
    if (!sent) return;
    reload();
    if (announce.current) toast.show(announce.current);
    announce.current = null;
  }, [sent, reload]);
  const press = async (state: 'started' | 'stopped') => {
    setRefused(null);
    announce.current = null;
    try {
      const made = await (state === 'started' ? startDay(ws, platform) : stopDay(ws, platform));
      setPressed({ state, id: made.id, at: Date.now() });
      const computerOpen =
        !!live.data?.computer && !isOffline(live.data.computer.lastSeenAt, Date.now());
      // With signal, a start is said once HandsFreeOS takes it (it may say why not); a stop always is.
      if (ctx.online && state === 'started') announce.current = W.started(computerOpen);
      else toast.show(ctx.online ? W.stopped : state === 'started' ? W.startQueued : W.stopQueued);
      if (ctx.online) setTimeout(reload, 1500);
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    }
  };
  return {
    platform,
    live: live.data,
    at: live.at,
    error: live.error,
    team: ctx.manages ? team.data : null,
    online: ctx.online,
    now: Date.now(),
    pressed: shown && pressed ? pressed.state : null,
    refused,
    manages,
    onRetry: reload,
    onStart: () => void press('started'),
    onStop: () => void press('stopped'),
    onWaiting: () => openOutreach(ws, 'today'),
    // What it does on its own is set on the network's own page of Settings; the team's say, on General.
    onSettings: () => openSettingsPart(ws, platform),
    onGeneral: () => openSettingsPart(ws, 'general'),
    asks: asks.data,
    askActions,
  };
}

export function LiveBody({
  platform = 'facebook',
  live,
  at,
  error,
  team,
  online,
  now,
  pressed,
  refused = null,
  manages = false,
  ready = true,
  held = null,
  onRetry,
  onStart,
  onStop,
  onWaiting,
  onSettings,
  onGeneral,
  asks = null,
  askActions,
  networks = [platform],
  onNetwork,
}: {
  /** The network whose day, warning and limits these are. */
  platform?: Platform;
  /** The networks the person works: with more than one, their names pick whose day shows. */
  networks?: readonly Platform[];
  onNetwork?: (platform: Platform) => void;
  live: LiveOutput | null;
  /** When the answer on screen came. */
  at: number | null;
  error: string | null;
  team: LiveTeamOutput | null;
  online: boolean;
  now: number;
  /** Start or Stop pressed on this phone, still waiting there to be sent (`pressShown`). */
  pressed: LiveDay['state'] | null;
  /** A Start HandsFreeOS refused: its words and where it's fixed, beside the button. */
  refused?: StartRefusedShown | null;
  /** An owner or admin: a business that allows only Off is theirs to change, on General. */
  manages?: boolean;
  /** Whether the person is ready on this network (decisions 63 and 90): until they are, Start waits and says why. */
  ready?: boolean;
  /** While it isn't ready: what holds the day under Get ready and where it's done (`notReadyWords`). */
  held?: string | null;
  onRetry: () => void;
  onStart: () => void;
  onStop: () => void;
  onWaiting: () => void;
  onSettings: () => void;
  /** Opens General in Settings, where an owner or admin allows the team more. */
  onGeneral?: () => void;
  /** What the person asked their computer, with signal. */
  asks?: AsksOutput | null;
  askActions?: AskActions;
}) {
  if (!live)
    return (
      <Screen title={W.rows.live} leading="back" testID="outreach-live">
        {error ? <NeedsSignal words={error} onRetry={onRetry} testID="live-needs-signal" /> : null}
      </Screen>
    );
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
  const others = live.computers.filter((c) => !c.working);
  const offline = computer !== null && isOffline(computer.lastSeenAt, now);
  // Another of their computers is open while the one that works isn't: say where to go (decision 41).
  const open = offline
    ? others.find((c) => c.state !== 'signed_out' && !isOffline(c.lastSeenAt, now))
    : undefined;
  // A Facebook warning stops the day, and Start my day can't undo it (ops/day.ts).
  const warned = live.day.why === 'warning';
  const stale = !online && at !== null;
  return (
    <Screen
      title={W.rows.live}
      subtitle={stale ? W.asOf(at!, tz) : undefined}
      leading="back"
      testID="outreach-live"
    >
      {!online ? <NeedsSignal words={W.needsSignal(W.rows.live)} testID="live-offline" /> : null}

      {networks.length > 1 && onNetwork ? (
        <View className="flex-row flex-wrap gap-1.5" testID="live-networks">
          {networks.map((p) => (
            <Button
              key={p}
              size="sm"
              variant={p === platform ? 'secondary' : 'ghost'}
              onPress={() => onNetwork(p)}
              testID={`live-network-${p}`}
            >
              {PLATFORMS[p]}
            </Button>
          ))}
        </View>
      ) : null}

      <Part title={W.rightNow} testID="live-now">
        <Card className="gap-2 px-4 py-3.5">
          <StateChip state={state} testID="live-state" />
          {computer ? (
            <>
              <Note testID="live-computer">
                {offline
                  ? offlineWords(computer.lastSeenAt, tz, now)
                  : W.onComputer(computer.name, seenWords(computer.lastSeenAt, tz, now))}
              </Note>
              {open ? <Note testID="live-other-open">{W.otherOpen(open.name)}</Note> : null}
              {live.status?.line ? (
                <Text className="text-[14.5px] leading-[21px]" testID="live-line">
                  {live.status.line}
                </Text>
              ) : null}
              {live.status?.nextAt ? (
                <Note>{W.nextStep(seenWords(live.status.nextAt, tz, now))}</Note>
              ) : null}
            </>
          ) : (
            <Note testID="live-no-computer">{W.noComputer}</Note>
          )}
          {others.map((c) => (
            <Note key={c.id} testID="live-other-computer">
              {W.otherComputer(c.name, c.state === 'signed_out', seenWords(c.lastSeenAt, tz, now))}
            </Note>
          ))}
          {computer ? <Note>{W.renameOnTheWeb}</Note> : null}
        </Card>
        {live.warning ? (
          <Card className="border-danger px-4 py-3" testID="live-warning">
            <Text className="text-[14px] leading-[20px] text-danger">
              {warningNote(live.warning, now, platform)}
            </Text>
          </Card>
        ) : null}
      </Part>

      <Card className="gap-2.5 px-4 py-3.5" testID="live-day">
        {live.sending === 'off' ? (
          <>
            <Note testID="live-sending-off">
              {runsOnItsOwn(platform)
                ? W.sendingOff(live.canSend, manages)
                : noRunnerWords(platform)}
            </Note>
            {runsOnItsOwn(platform) && live.canSend ? (
              <Button variant="secondary" size="md" onPress={onSettings} testID="live-settings">
                {W.rows.settings}
              </Button>
            ) : runsOnItsOwn(platform) && manages && onGeneral ? (
              <Button variant="secondary" size="md" onPress={onGeneral} testID="live-general">
                {W.settingsGeneral}
              </Button>
            ) : null}
          </>
        ) : (
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              icon={Play}
              disabled={day.state === 'started' || warned || !ready}
              onPress={onStart}
              testID="live-start"
            >
              {W.startDay}
            </Button>
            <Button
              className="flex-1"
              variant="secondary"
              icon={Pause}
              disabled={day.state === 'stopped'}
              onPress={onStop}
              testID="live-stop"
            >
              {W.stopDay}
            </Button>
          </View>
        )}
        {/* Beside a Start my day that waits on Get ready: what holds it, and where it's done. */}
        {ready || day.state === 'started' || live.sending === 'off' ? null : (
          <Note testID="live-not-ready">{held || READY_WORDS.stripNotReady}</Note>
        )}
        {refused && day.state !== 'started' ? <StartRefusedNote refused={refused} /> : null}
        {dayWords(day, tz, live.lists, platform) ? (
          <Note testID="live-day-words">{dayWords(day, tz, live.lists, platform)}</Note>
        ) : null}
        {pressed ? <QueuedNote online={online} /> : null}
      </Card>

      <PreDayPart live={{ ...live, day }} now={now} platform={platform} />

      {asks && askActions ? <AskedPart asks={asks} actions={askActions} /> : null}

      <Part title={W.todaySoFar} testID="live-limits">
        <List>
          {DAILY_STEPS.map((step) => (
            <ListRow
              key={step}
              label={dailyWordsOn(platform)[step].label}
              end={
                <Text className="text-[14px] text-text-2">
                  {W.countOf(live.limits[step].done, live.limits[step].most)}
                </Text>
              }
              chevron={false}
              testID={`live-limit-${step}`}
            />
          ))}
          <ListRow
            icon={Inbox}
            label={W.waitingLink(live.waiting)}
            onPress={onWaiting}
            testID="live-waiting"
          />
        </List>
      </Part>

      <Part title={W.todaySteps} testID="live-steps">
        <Card className="gap-2 px-4 py-3.5">
          {live.steps.length ? (
            live.steps.map((step, i) => (
              <View key={`${step.at}:${i}`} className="flex-row gap-3">
                <Text className="w-[64px] text-[13px] text-text-3">{clockWords(step.at, tz)}</Text>
                <Text className="flex-1 text-[14px] leading-[20px]">{step.line}</Text>
              </View>
            ))
          ) : (
            <Note>{W.noSteps}</Note>
          )}
        </Card>
      </Part>

      {team ? <TeamPart team={team} now={now} /> : null}
    </Screen>
  );
}

function TeamPart({ team, now }: { team: LiveTeamOutput; now: number }) {
  return (
    <Part title={teamWordsOn(team.platform).title} testID="live-team">
      {team.people.length ? (
        <List>
          {team.people.map((p) => {
            const state = shownState({
              computer: p.computer,
              day: p.day,
              sending: p.sending,
              now,
            });
            return (
              <ListRow
                key={p.userId}
                label={p.name}
                detail={[
                  W.teamComputer(
                    p.computer?.name ?? null,
                    p.computer ? seenWords(p.computer.lastSeenAt, team.timezone, now) : null,
                  ),
                  W.teamWaiting(p.waiting),
                  p.warned ? W.warned : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                end={<StateChip state={state} />}
                chevron={false}
                testID="live-team-person"
              />
            );
          })}
        </List>
      ) : (
        <Note>{teamWordsOn(team.platform).none}</Note>
      )}
    </Part>
  );
}

const PRE_DAY_END = { done: 'Done', now: 'Under way', next: 'To come' } as const;

/**
 * The steps before the first day as a checklist (docs/outreach.md, decision 60 "Lists first"): each ticked once done,
 * the one under way with what the computer says it's doing, while it works. Gone once all are done.
 */
export function PreDayPart({
  live,
  now,
  platform = 'facebook',
}: {
  live: LiveOutput;
  now: number;
  /** The network whose steps before its first day these are. */
  platform?: Platform;
}) {
  // The count under the step the computer says it's doing, while it works and is online.
  const steps = preDaySteps(live.lists, preDayNow(live, now), platform);
  if (!steps.length || live.day.state !== 'started') return null;
  return (
    <Part title={PRE_DAY_TITLE} about={preDayCount(steps)} testID="live-pre-day">
      <List>
        {steps.map((step) => (
          <ListRow
            key={step.key}
            icon={step.state === 'done' ? Check : step.state === 'now' ? LoaderCircle : undefined}
            label={step.label}
            detail={step.progress ?? undefined}
            end={
              <Text
                className={
                  step.state === 'next' ? 'text-[14px] text-text-3' : 'text-[14px] text-text-2'
                }
              >
                {PRE_DAY_END[step.state]}
              </Text>
            }
            chevron={false}
            testID={`live-pre-day-${step.key}`}
          />
        ))}
      </List>
    </Part>
  );
}
