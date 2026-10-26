'use client';
/**
 * Social Outreach's Live tab (docs/outreach.md, decision 41): what the person's extension is doing right now, on which
 * computer, and what's next; Start my day and Stop for today, which reach that computer within seconds; today's counts
 * against the limits and how many things wait for the person (Waiting for you); today's steps; their computers, renamable
 * and removable, one or every one standing by (decision 85); and for owners
 * and admins, each person's status, counts and how many wait, never their lines or messages. It follows changes live,
 * and works out "offline" itself on a 30-second clock, so the note shows with no event at all. A heartbeat tells
 * nobody, so while the tab is shown it also asks again every minute, which keeps "last seen" moving: a computer still
 * beating is never called offline.
 *
 * Each network's day is its own: with more than one network on, its names pick which (`?net=`), and Start my day and
 * Stop for today, the counts, the first lists and the warning are that network's.
 */
import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  clockWords,
  COMPUTER_NAME_MOST,
  dayWords,
  isOffline,
  LIVE_REFETCH_SECONDS,
  offlineWords,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
  type ShownState,
} from '@hfos/core/addons/outreach/live';
import {
  dailyWordsOn,
  NETWORK_WORDS as NW,
  noRunnerWords,
  teamWordsOn,
} from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, runsOnItsOwn, type Platform } from '@hfos/core/addons/outreach/networks';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Segmented } from '@/components/ui/segmented';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { AskLine } from './asks';
import { ASK_WORDS } from '@hfos/core/addons/outreach/asks';
import type { Asks, Live, LiveTeam } from './types';
import { PreDayList } from './pre-day-list';
import {
  keptBesideStart,
  startRefused,
  StartRefusedNote,
  type StartRefused,
} from './start-refused';
import { useAct } from './use-act';

const TONES: Record<ReturnType<typeof stateTone>, BadgeVariant> = {
  good: 'ok',
  waiting: 'accent',
  warn: 'pending',
  plain: 'gray',
};

export function StateChip({ state, testId }: { state: ShownState; testId?: string }) {
  return (
    <Badge variant={TONES[stateTone(state)]} data-testid={testId}>
      {SHOWN_STATES[state]}
    </Badge>
  );
}

/**
 * The server's clock, moving on: it starts at the answer's `now` (so the page draws the same on the server and in the
 * browser), then adds the time passed in the browser every 30 seconds. A fresh answer starts it again.
 */
export function useServerNow(serverNow: string, everyMs = 30_000): number {
  const server = Date.parse(serverNow);
  const [tick, setTick] = useState<{ readonly server: number; readonly now: number } | null>(null);
  useEffect(() => {
    const arrived = Date.now();
    const t = setInterval(() => setTick({ server, now: server + Date.now() - arrived }), everyMs);
    return () => clearInterval(t);
  }, [server, everyMs]);
  return tick && tick.server === server ? tick.now : server;
}

/** Asks again on a clock while the tab is shown: what a heartbeat brings (the last-seen time) tells nobody. */
export function useRefetchWhileShown(everyMs = LIVE_REFETCH_SECONDS * 1000): void {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
}

export function LiveView({
  workspaceId,
  live,
  team,
  asks,
  platform = 'facebook',
  networks = [platform],
}: {
  workspaceId: string;
  live: Live;
  /** Everyone's status, for owners and admins. */
  team: LiveTeam | null;
  /** What the person asked their computer to do from here: today's and the open ones. */
  asks: Asks;
  /** The network whose day it is, of those the person works. */
  platform?: Platform;
  networks?: readonly Platform[];
}) {
  const router = useRouter();
  useLiveRefresh(
    [
      'outreach_computer',
      'outreach_ask',
      'outreach_need',
      'outreach_day',
      'outreach_profile',
      'outreach_automation',
      'workspace',
      'addon',
    ],
    800,
  );
  useRefetchWhileShown();
  const now = useServerNow(live.now);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]" data-testid="outreach-live">
      <div className="grid content-start gap-4">
        {networks.length > 1 ? (
          <div className="max-w-full overflow-x-auto">
            <Segmented<Platform>
              ariaLabel={NW.filter}
              value={platform}
              onChange={(net) => router.push(outreachHref(workspaceId, { view: 'live', net }))}
              options={networks.map((p) => ({
                value: p,
                label: PLATFORMS[p],
                testId: `live-network-${p}`,
              }))}
            />
          </div>
        ) : null}
        <RightNow
          workspaceId={workspaceId}
          live={live}
          now={now}
          platform={platform}
          canManage={team !== null}
        />
        <AskedCard workspaceId={workspaceId} asks={asks} />
        <StepsCard live={live} />
        {team ? <TeamCard team={team} now={now} /> : null}
      </div>
      <div className="grid content-start gap-4">
        <CountsCard workspaceId={workspaceId} live={live} platform={platform} />
        <ComputersCard workspaceId={workspaceId} live={live} now={now} />
      </div>
    </div>
  );
}

function RightNow({
  workspaceId,
  live,
  now,
  platform,
  canManage = false,
}: {
  workspaceId: string;
  live: Live;
  now: number;
  platform: Platform;
  /** An owner or admin: a refused Start may point them to the business's part to fix. */
  canManage?: boolean;
}) {
  const { busy, act } = useAct();
  // A refused Start stays beside the buttons in the server's words, with where the setup fixes it.
  const [refused, setRefused] = useState<StartRefused | null>(null);
  const tz = live.timezone;
  const computer = live.computer;
  const state = shownState({
    computer: computer ? { state: computer.state, lastSeenAt: computer.lastSeenAt } : null,
    day: live.day,
    sending: live.sending,
    now,
  });
  const offline = computer !== null && isOffline(computer.lastSeenAt, now);
  // Another of their computers is open while the one that works isn't: say where to go.
  const open = offline
    ? live.computers.find(
        (c) => !c.working && c.state !== 'signed_out' && !isOffline(c.lastSeenAt, now),
      )
    : undefined;
  const status = live.status;
  const sendingOff = live.sending === 'off';
  const started = live.day.state === 'started';
  const stopped = live.day.state === 'stopped';
  const said = dayWords(live.day, tz, live.lists, platform);
  const press = (kind: 'start' | 'stop') => {
    setRefused(null);
    void act(
      kind,
      async () => {
        try {
          return unwrap(
            kind === 'start'
              ? await apiBrowser().POST('/v1/commands/outreach.day.start', {
                  body: { workspaceId, platform },
                })
              : await apiBrowser().POST('/v1/commands/outreach.day.stop', {
                  body: { workspaceId, platform },
                }),
          );
        } catch (e) {
          if (kind === 'start') setRefused(startRefused(e, platform, canManage));
          throw e;
        }
      },
      kind === 'stop' ? W.stopped : W.started(!offline && computer !== null),
      // Kept beside the buttons (below), not toasted; anything else is (a route not served yet among them).
      kind === 'start' ? keptBesideStart : undefined,
    );
  };
  return (
    <Card className="p-4" data-testid="live-now">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">{W.rightNow}</h3>
        <StateChip state={state} testId="live-state" />
      </div>
      {computer ? (
        <>
          {status?.line && !offline && state !== 'signed_out' ? (
            <p className="mt-2 text-[14px]" role="status" data-testid="live-line">
              {status.line}
            </p>
          ) : null}
          {status?.nextAt && state === 'waiting' ? (
            <p className="mt-1 text-[13px] text-text-2" data-testid="live-next">
              {W.nextStep(seenWords(status.nextAt, tz, now))}
            </p>
          ) : null}
          <p className="mt-1 text-[12.5px] text-text-3" data-testid="live-computer">
            {W.onComputer(computer.name, seenWords(computer.lastSeenAt, tz, now))}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-text-2" data-testid="live-no-computer">
          {W.noComputer}
        </p>
      )}
      <PreDayList live={live} now={now} platform={platform} className="mt-3" />
      {offline && computer ? (
        <p
          role="status"
          data-testid="live-offline"
          className="mt-3 rounded-menu bg-warning-soft p-2.5 text-[12.5px] text-warning-text"
        >
          {offlineWords(computer.lastSeenAt, tz, now)}
          {open ? ` ${W.otherOpen(open.name)}` : null}
        </p>
      ) : null}
      {live.warning ? (
        <p
          role="alert"
          data-testid="live-warning"
          className="mt-3 rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
        >
          {warningNote(live.warning, now, platform)}
        </p>
      ) : null}
      {sendingOff ? (
        <p
          className="mt-3 rounded-menu bg-card-2 p-2.5 text-[12.5px] text-text-2"
          data-testid="live-sending-off"
        >
          {!runsOnItsOwn(platform) ? (
            noRunnerWords(platform)
          ) : (
            <>
              {W.sendingOffNote}{' '}
              {live.canSend ? (
                <>
                  {W.changeThatIn}{' '}
                  <Link
                    className="font-medium text-accent-text underline-offset-2 hover:underline"
                    href={outreachHref(workspaceId, { view: 'settings', part: platform })}
                  >
                    {W.rows.settings}
                  </Link>
                  .
                </>
              ) : canManage ? (
                // The business allows only Off, and this owner or admin can change that: where.
                <>
                  {W.allowForTeamIn}{' '}
                  <Link
                    className="font-medium text-accent-text underline-offset-2 hover:underline"
                    href={outreachHref(workspaceId, { view: 'settings', part: 'general' })}
                    data-testid="live-sending-off-general"
                  >
                    {W.settingsGeneral}
                  </Link>
                  .
                </>
              ) : (
                W.askToSend
              )}
            </>
          )}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          onClick={() => press('start')}
          loading={busy === 'start'}
          disabled={busy !== null || sendingOff || started || live.day.why === 'warning'}
          data-testid="live-start"
        >
          {W.startDay}
        </Button>
        <Button
          variant="secondary"
          onClick={() => press('stop')}
          loading={busy === 'stop'}
          disabled={busy !== null || stopped}
          data-testid="live-stop"
        >
          {W.stopDay}
        </Button>
      </div>
      {refused ? (
        <StartRefusedNote workspaceId={workspaceId} refused={refused} className="mt-3" />
      ) : null}
      {said ? (
        <p className="mt-2 text-[12.5px] text-text-3" data-testid="live-day">
          {said}
        </p>
      ) : null}
    </Card>
  );
}

/** What the person asked their computer to do from the other tabs, today's and the open ones, each as it goes. */
function AskedCard({ workspaceId, asks }: { workspaceId: string; asks: Asks }) {
  return (
    <Card className="p-4" data-testid="live-asks">
      <h3 className="text-[15px] font-semibold">{ASK_WORDS.askedTitle}</h3>
      {asks.asks.length ? (
        <ul className="mt-3 grid gap-2">
          {asks.asks.map((a) => (
            <li key={a.askId} data-testid="live-ask">
              <AskLine workspaceId={workspaceId} asks={asks} ask={a} named />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[13px] text-text-2" data-testid="live-asks-empty">
          {ASK_WORDS.askedNone}
        </p>
      )}
    </Card>
  );
}

function CountsCard({
  workspaceId,
  live,
  platform,
}: {
  workspaceId: string;
  live: Live;
  platform: Platform;
}) {
  const words = dailyWordsOn(platform);
  return (
    <Card className="p-4" data-testid="live-counts">
      <h3 className="text-[15px] font-semibold">{W.todaySoFar}</h3>
      <ul className="mt-3 space-y-1.5">
        {DAILY_STEPS.map((step) => {
          const { done, most } = live.limits[step];
          const full = done >= most;
          return (
            <li
              key={step}
              className="flex items-baseline justify-between gap-2 text-[13px]"
              data-testid={`live-count-${step}`}
            >
              <span>{words[step].label}</span>
              <span
                className={cn(
                  'tabular-nums',
                  full ? 'font-semibold text-warning-text' : 'text-text-2',
                )}
              >
                {W.countOf(done, most)}
              </span>
            </li>
          );
        })}
      </ul>
      {live.waiting > 0 ? (
        <p className="mt-3 text-[13px]" data-testid="live-waiting">
          <Link
            className="font-medium text-accent-text underline-offset-2 hover:underline"
            href={outreachHref(workspaceId, { view: 'today' })}
          >
            {W.waitingLink(live.waiting)}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

function StepsCard({ live }: { live: Live }) {
  return (
    <Card className="p-4" data-testid="live-steps">
      <h3 className="text-[15px] font-semibold">{W.todaySteps}</h3>
      {live.steps.length ? (
        <ol className="mt-3 space-y-1.5">
          {live.steps.map((step, i) => (
            <li key={`${step.at}-${i}`} className="flex gap-3 text-[13px]">
              <span className="w-[68px] flex-none tabular-nums text-text-3">
                {clockWords(step.at, live.timezone)}
              </span>
              <span
                className={cn(
                  step.kind === 'stopped' && 'text-danger-text',
                  step.kind === 'passed' && 'text-text-2',
                )}
              >
                {step.line}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-2 text-[13px] text-text-2">{W.noSteps}</p>
      )}
    </Card>
  );
}

export function ComputersCard({
  workspaceId,
  live,
  now,
  bare = false,
}: {
  workspaceId: string;
  live: Live;
  now: number;
  /** Inside another card (Settings' Your computer): no card or title of its own. */
  bare?: boolean;
}) {
  const { busy, act } = useAct();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [clearing, setClearing] = useState(false);
  if (!live.computers.length) return null;
  const standingBy = live.computers.filter((c) => !c.working);
  const save = (computerId: string) =>
    void act(
      `rename:${computerId}`,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.computer.rename', {
            body: { workspaceId, computerId, name },
          }),
        ),
      'Renamed.',
    ).then((ok) => ok && setEditing(null));
  // Never the one that works: HandsFreeOS refuses it too. One still running comes back at its next beat.
  const remove = (key: string, computerIds: string[], done: string) =>
    void act(
      key,
      async () =>
        unwrap(
          await apiBrowser().POST('/v1/commands/outreach.computer.remove', {
            body: { workspaceId, computerIds },
          }),
        ),
      done,
    ).then((ok) => ok && setClearing(false));
  const Box = bare ? 'div' : Card;
  return (
    <Box className={bare ? undefined : 'p-4'} data-testid="live-computers">
      {bare ? null : <h3 className="text-[15px] font-semibold">Your computers</h3>}
      <p className={cn('text-[12.5px] text-text-3', !bare && 'mt-0.5')}>
        The one you used last works; the others stand by. Open the panel on one to work from it.
      </p>
      {standingBy.length > 1 ? (
        clearing ? (
          <div
            className="mt-3 rounded-menu bg-card-2 px-3.5 py-2.5"
            role="alert"
            data-testid="live-computers-clearing"
          >
            <p className="text-[13px]">
              Remove the {standingBy.length} computers standing by? One the extension still runs on
              comes back the next time it checks in.
            </p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="danger"
                loading={busy === 'remove:standing'}
                onClick={() =>
                  remove(
                    'remove:standing',
                    standingBy.map((c) => c.id),
                    `Removed ${standingBy.length} computers.`,
                  )
                }
              >
                Remove them
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setClearing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            className="mt-2"
            size="sm"
            variant="secondary"
            onClick={() => setClearing(true)}
            data-testid="live-computers-clear"
          >
            Remove the {standingBy.length} standing by
          </Button>
        )
      ) : null}
      <ul className="mt-3 space-y-3">
        {live.computers.map((c) => (
          <li key={c.id} data-testid="live-computer-row">
            {editing === c.id ? (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save(c.id);
                }}
              >
                <Input
                  aria-label="Computer name"
                  value={name}
                  maxLength={COMPUTER_NAME_MOST}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
                <Button type="submit" size="sm" loading={busy === `rename:${c.id}`}>
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-medium">{c.name}</div>
                  <div className="text-[12px] text-text-3">
                    {c.state === 'signed_out'
                      ? W.computerStates.signedOut
                      : c.working
                        ? W.computerStates.working
                        : W.computerStates.standingBy}{' '}
                    · seen {seenWords(c.lastSeenAt, live.timezone, now)}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setName(c.name);
                      setEditing(c.id);
                    }}
                  >
                    Rename
                  </Button>
                  {c.working ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy === `remove:${c.id}`}
                      onClick={() => remove(`remove:${c.id}`, [c.id], `Removed ${c.name}.`)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Box>
  );
}

function TeamCard({ team, now }: { team: LiveTeam; now: number }) {
  const words = teamWordsOn(team.platform);
  return (
    <Card className="p-4" data-testid="live-team">
      <h3 className="text-[15px] font-semibold">{words.title}</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        How each person’s extension is doing today. What it says and who it reaches stay theirs.
      </p>
      {team.people.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead className="text-[12px] text-text-3">
              <tr>
                <th className="py-1.5 pr-3 font-medium">Person</th>
                <th className="py-1.5 pr-3 font-medium">Now</th>
                <th className="py-1.5 pr-3 font-medium">Computer</th>
                <th className="py-1.5 pr-3 font-medium">Today</th>
                <th className="py-1.5 font-medium">Waiting</th>
              </tr>
            </thead>
            <tbody>
              {team.people.map((p) => {
                // Worked out again as time passes, so someone goes offline here with no event.
                const state = shownState({
                  computer: p.computer,
                  day: p.day,
                  sending: p.sending,
                  now,
                });
                return (
                  <tr
                    key={p.userId}
                    className="border-t border-border align-top"
                    data-testid="live-team-row"
                  >
                    <td className="py-2 pr-3 font-medium">
                      {p.name}
                      {p.warned ? (
                        <span className="ml-1.5 text-[12px] text-danger-text">{W.warned}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <StateChip state={state} />
                    </td>
                    <td className="py-2 pr-3 text-text-2">
                      {W.teamComputer(
                        p.computer?.name ?? null,
                        p.computer ? seenWords(p.computer.lastSeenAt, team.timezone, now) : null,
                      )}
                    </td>
                    <td className="py-2 pr-3 text-text-2">
                      {DAILY_STEPS.filter((s) => p.limits[s].most > 0)
                        .map(
                          (s) => `${DAILY_WORDS[s].label} ${p.limits[s].done}/${p.limits[s].most}`,
                        )
                        .join(' · ')}
                    </td>
                    <td className="py-2 tabular-nums">{p.waiting}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title={words.noneTitle} dashed className="mt-3" />
      )}
    </Card>
  );
}
