import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  clockWords,
  dayWords,
  isOffline,
  LIVE_REFETCH_SECONDS,
  offlineWords,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
  type LiveDay,
  type LiveOutput,
  type LiveTeamOutput,
  type ShownState,
} from '@hfos/core/addons/outreach/live';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import type { AsksOutput } from '@hfos/core/addons/outreach/asks';
import * as React from 'react';
import { View } from 'react-native';

import { ChangeError } from '@/changes';
import { useChange } from '@/changes/hooks';
import type { ChangeState } from '@/changes/rules';
import { Inbox, Pause, Play } from '@/components/icons';
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
  Part,
  QueuedNote,
  useOutreachAnswer,
  useOutreachContext,
} from './kit';

/**
 * The live view on the phone (decision 44): what the person's extension is doing now, asked again every minute while
 * the screen is open (`LIVE_REFETCH_SECONDS`), Start my day and Stop for today, today's counts against the daily
 * limits, what the person asked their computer (decision 43, with **Carry on**, **Skip** and **Stop**), and today's
 * steps; for owners and admins, each person's state. Start and Stop wait on the phone with no
 * signal and go when it's back; the rest needs signal, and with none the last answer stays, "As of" when it came.
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

export function StateChip({ state, testID }: { state: ShownState; testID?: string }) {
  return (
    <Badge variant={TONE_BADGE[stateTone(state)]} testID={testID}>
      <Text>{SHOWN_STATES[state]}</Text>
    </Badge>
  );
}

export function LiveScreen() {
  return <LiveBody {...useLiveProps()} />;
}

/** The live answer, Start and Stop with what waits on the phone: for its own screen and Today's strip (./hub.tsx). */
export function useLiveProps(full = true): React.ComponentProps<typeof LiveBody> {
  const ctx = useOutreachContext();
  const ws = ctx.workspaceId;
  const live = useOutreachAnswer(
    async () => unwrap(await api.POST('/v1/queries/outreach.live', { body: { workspaceId: ws } })),
    `live:${ws}`,
    W.rows.live,
    { everySeconds: LIVE_REFETCH_SECONDS },
  );
  // The team's only on the live screen itself.
  const team = useOutreachAnswer(
    ctx.manages && full
      ? async () =>
          unwrap(await api.POST('/v1/queries/outreach.live.team', { body: { workspaceId: ws } }))
      : null,
    `live-team:${ws}`,
    W.team,
    { everySeconds: LIVE_REFETCH_SECONDS },
  );
  const asks = useAsks(null, W.rows.live);
  const askActions = useAskActions(asks.data, asks.reload);
  // A press waits on the phone with no signal: the day shows as pressed while it waits there, then HandsFreeOS's answer.
  const [pressed, setPressed] = React.useState<Press | null>(null);
  const queued = useChange(pressed?.id ?? '');
  const shown = pressShown(pressed, queued, live.at);
  const sent = queued?.state === 'sent';
  const { reload } = live;
  React.useEffect(() => {
    if (pressed && !shown) setPressed(null);
  }, [pressed, shown]);
  React.useEffect(() => {
    if (sent) reload();
  }, [sent, reload]);
  const press = async (state: 'started' | 'stopped') => {
    try {
      const made = await (state === 'started' ? startDay(ws) : stopDay(ws));
      setPressed({ state, id: made.id, at: Date.now() });
      const computerOpen =
        !!live.data?.computer && !isOffline(live.data.computer.lastSeenAt, Date.now());
      toast.show(
        ctx.online
          ? state === 'started'
            ? W.started(computerOpen)
            : W.stopped
          : state === 'started'
            ? W.startQueued
            : W.stopQueued,
      );
      if (ctx.online) setTimeout(reload, 1500);
    } catch (e) {
      toast.error(e instanceof ChangeError ? e.message : errorMessage(e));
    }
  };
  return {
    live: live.data,
    at: live.at,
    error: live.error,
    team: ctx.manages ? team.data : null,
    online: ctx.online,
    now: Date.now(),
    pressed: shown && pressed ? pressed.state : null,
    onRetry: reload,
    onStart: () => void press('started'),
    onStop: () => void press('stopped'),
    onWaiting: () => openOutreach(ws, 'today'),
    onSettings: () => openOutreach(ws, 'settings'),
    asks: asks.data,
    askActions,
  };
}

export function LiveBody({
  live,
  at,
  error,
  team,
  online,
  now,
  pressed,
  onRetry,
  onStart,
  onStop,
  onWaiting,
  onSettings,
  asks = null,
  askActions,
}: {
  live: LiveOutput | null;
  /** When the answer on screen came. */
  at: number | null;
  error: string | null;
  team: LiveTeamOutput | null;
  online: boolean;
  now: number;
  /** Start or Stop pressed on this phone, still waiting there to be sent (`pressShown`). */
  pressed: LiveDay['state'] | null;
  onRetry: () => void;
  onStart: () => void;
  onStop: () => void;
  onWaiting: () => void;
  onSettings: () => void;
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
              {warningNote(live.warning, now)}
            </Text>
          </Card>
        ) : null}
      </Part>

      <Card className="gap-2.5 px-4 py-3.5" testID="live-day">
        {live.sending === 'off' ? (
          <>
            <Note testID="live-sending-off">{W.sendingOff(live.canSend)}</Note>
            {live.canSend ? (
              <Button variant="secondary" size="md" onPress={onSettings} testID="live-settings">
                {W.rows.settings}
              </Button>
            ) : null}
          </>
        ) : (
          <View className="flex-row gap-2">
            <Button
              className="flex-1"
              icon={Play}
              disabled={day.state === 'started' || warned}
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
        {dayWords(day, tz) ? <Note testID="live-day-words">{dayWords(day, tz)}</Note> : null}
        {pressed ? <QueuedNote online={online} /> : null}
      </Card>

      {asks && askActions ? <AskedPart asks={asks} actions={askActions} /> : null}

      <Part title={W.todaySoFar} testID="live-limits">
        <List>
          {DAILY_STEPS.map((step) => (
            <ListRow
              key={step}
              label={DAILY_WORDS[step].label}
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
    <Part title={W.team} testID="live-team">
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
        <Note>{W.teamNone}</Note>
      )}
    </Part>
  );
}
