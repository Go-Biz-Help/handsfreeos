'use client';
/**
 * The top of Today (docs/outreach.md, decisions 41 and 59): what the person's computer is doing, what's next, today's
 * steps against the daily limits, and Start my day and Stop for today, in one strip, so nobody opens another tab to
 * see whether it's working. Offline, a warning, and Sending off each say so in a line. **Details** opens the
 * full day (./live-view.tsx): the feed, what was asked of the computer, the team, and renaming computers.
 *
 * Each network on its own (Chris): with more than one network on, the strip has a row for each, by name, with its own
 * day, its own Start my day or Stop for today (`outreach.day.*` with its `platform`) and its own warning line, and
 * **Start all** and **Stop all** press each one. Stopping one leaves the others going. The limits, the first lists
 * and the list below are the network shown (`?net=`); its name opens it.
 */
import { DAILY_STEPS } from '@hfos/core/addons/outreach/limits';
import {
  dayWords,
  isOffline,
  offlineWords,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
} from '@hfos/core/addons/outreach/live';
import { dailyWordsOn, NETWORK_WORDS as NW } from '@hfos/core/addons/outreach/network-words';
import { PLATFORMS, type Platform } from '@hfos/core/addons/outreach/networks';
import { READY_WORDS } from '@hfos/core/addons/outreach/readiness';
import { SETUP_WORDS } from '@hfos/core/addons/outreach/setup';
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { Clock } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import { useRefetchWhileShown, useServerNow } from './live-view';
import type { Live } from './types';
import { PreDayList } from './pre-day-list';
import { useAct } from './use-act';

const DOT: Record<ReturnType<typeof stateTone>, string> = {
  good: 'bg-success shadow-[0_0_0_4px_var(--success-soft)]',
  waiting: 'bg-accent shadow-[0_0_0_4px_var(--accent-soft)]',
  warn: 'bg-warning shadow-[0_0_0_4px_var(--warning-soft)]',
  plain: 'bg-text-3 shadow-[0_0_0_4px_var(--card-2)]',
};

/** A network the person works, with the live view of it: its day, warning, limits and lists. */
export interface NetworkLive {
  readonly platform: Platform;
  readonly live: Live;
  /** Whether the person is ready there, its own profile counting: the strip's `ready` when not known. */
  readonly ready?: boolean;
}

type Press = 'start' | 'stop';
/** The server's clock when no network's answer came: nothing is shown then. */
const NO_ANSWER = '1970-01-01T00:00:00.000Z';

const pressDay = async (workspaceId: string, platform: Platform, kind: Press) =>
  unwrap(
    kind === 'start'
      ? await apiBrowser().POST('/v1/commands/outreach.day.start', {
          body: { workspaceId, platform },
        })
      : await apiBrowser().POST('/v1/commands/outreach.day.stop', {
          body: { workspaceId, platform },
        }),
  );

/** Whether a network's day can be started now: ready there, working on its own there, and no warning there today. */
const canStart = (n: NetworkLive, ready: boolean) =>
  (n.ready ?? ready) && n.live.sending !== 'off' && n.live.day.why !== 'warning';

export function StatusStrip({
  workspaceId,
  networks,
  platform,
  ready = true,
}: {
  workspaceId: string;
  /** Each network the person works, with its live view, in the kit's order. */
  networks: readonly NetworkLive[];
  /** The network shown: its limits, its first lists and its list below. */
  platform: Platform;
  /** Whether the person is ready (decision 63): until they are, Start my day waits and says why. */
  ready?: boolean;
}) {
  useRefetchWhileShown();
  const shown = networks.find((n) => n.platform === platform) ?? networks[0];
  const now = useServerNow(shown?.live.now ?? NO_ANSWER);
  const { busy, act } = useAct();
  if (!shown) return null;
  const live = shown.live;
  const many = networks.length > 1;
  const tz = live.timezone;
  const computer = live.computer;
  const state = shownState({
    computer: computer ? { state: computer.state, lastSeenAt: computer.lastSeenAt } : null,
    day: live.day,
    sending: live.sending,
    now,
  });
  const offline = computer !== null && isOffline(computer.lastSeenAt, now);
  const open = offline
    ? live.computers.find(
        (c) => !c.working && c.state !== 'signed_out' && !isOffline(c.lastSeenAt, now),
      )
    : undefined;
  const computerOpen = !offline && computer !== null;
  const line =
    computer && live.status?.line && !offline && state !== 'signed_out' ? live.status.line : null;
  const next =
    computer && live.status?.nextAt && state === 'waiting'
      ? seenWords(live.status.nextAt, tz, now)
      : null;
  const press = (p: Platform, kind: Press) =>
    void act(
      `${p}:${kind}`,
      () => pressDay(workspaceId, p, kind),
      kind === 'start' ? W.started(computerOpen) : many ? NW.stoppedOn(PLATFORMS[p]) : W.stopped,
    );
  // Start all and Stop all just press each one that can be.
  const toStart = networks.filter((n) => n.live.day.state !== 'started' && canStart(n, ready));
  const toStop = networks.filter((n) => n.live.day.state === 'started');
  const pressAll = (kind: Press) =>
    void act(
      kind,
      async () => {
        for (const n of kind === 'start' ? toStart : toStop)
          await pressDay(workspaceId, n.platform, kind);
      },
      kind === 'start' ? W.started(computerOpen) : W.stopped,
    );
  const dayButton = (n: NetworkLive, testId: string) =>
    n.live.day.state === 'started' ? (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => press(n.platform, 'stop')}
        loading={busy === `${n.platform}:stop`}
        disabled={busy !== null}
        data-testid={testId.replace('{}', 'stop')}
      >
        {W.stopDay}
      </Button>
    ) : (
      <Button
        variant="secondary"
        size="sm"
        onClick={() => press(n.platform, 'start')}
        loading={busy === `${n.platform}:start`}
        disabled={busy !== null || !canStart(n, ready)}
        data-testid={testId.replace('{}', 'start')}
      >
        {W.startDay}
      </Button>
    );
  const words = dailyWordsOn(shown.platform);
  const steps = DAILY_STEPS.filter((s) => live.limits[s].most > 0);
  const said = many ? '' : dayWords(live.day, tz, live.lists, shown.platform);
  return (
    <Card className="mb-5 grid gap-4 p-5" data-testid="today-status">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn('h-2.5 w-2.5 flex-none rounded-full', DOT[stateTone(state)])}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold" data-testid="live-state">
              {SHOWN_STATES[state]}
            </p>
            <p className="text-[13px] text-text-2" data-testid="today-status-line">
              {line ??
                (computer
                  ? W.onComputer(computer.name, seenWords(computer.lastSeenAt, tz, now))
                  : W.noComputer)}
            </p>
            {computer ? null : (
              <Link
                href={outreachHref(workspaceId, { view: 'settings', part: 'computer' })}
                className="text-[13px] font-medium text-accent-text hover:underline"
                data-testid="today-status-get-extension"
              >
                {SETUP_WORDS.download}
              </Link>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {next ? (
            <span
              className="inline-flex h-8 items-center gap-1.5 rounded-menu bg-card-2 px-3 text-[13px]"
              data-testid="live-next"
            >
              <Clock className="h-3.5 w-3.5 text-text-2" strokeWidth={1.75} aria-hidden="true" />
              {W.nextStep(next)}
            </span>
          ) : null}
          {many ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => pressAll('start')}
                loading={busy === 'start'}
                disabled={busy !== null || !toStart.length}
                data-testid="live-start-all"
              >
                {NW.startAll}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => pressAll('stop')}
                loading={busy === 'stop'}
                disabled={busy !== null || !toStop.length}
                data-testid="live-stop-all"
              >
                {NW.stopAll}
              </Button>
            </>
          ) : (
            dayButton(shown, 'live-{}')
          )}
          <Link
            href={outreachHref(workspaceId, { view: 'live', net: shown.platform })}
            className="px-1 text-[13px] font-medium text-accent-text hover:underline"
            data-testid="today-status-details"
          >
            {W.computerDetails}
          </Link>
        </div>
      </div>
      {many ? (
        <ul className="grid gap-2" aria-label={NW.stripTitle} data-testid="today-networks">
          {networks.map((n) => {
            const name = PLATFORMS[n.platform];
            const here = n.platform === shown.platform;
            return (
              <li
                key={n.platform}
                className={cn(
                  'grid gap-1.5 rounded-menu border px-3.5 py-2.5',
                  here ? 'border-accent bg-accent-soft' : 'border-border',
                )}
                data-testid={`today-network-${n.platform}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={outreachHref(workspaceId, { view: 'today', net: n.platform })}
                      aria-current={here ? 'true' : undefined}
                      title={NW.showList(name)}
                      className="text-[14px] font-semibold hover:underline"
                      data-testid={`today-network-${n.platform}-open`}
                    >
                      {name}
                    </Link>
                    <p className="text-[12.5px] text-text-2" data-testid="live-day">
                      {dayWords(n.live.day, tz, n.live.lists, n.platform) || NW.notStarted}
                    </p>
                  </div>
                  {dayButton(n, `live-{}-${n.platform}`)}
                </div>
                {n.live.warning ? (
                  <p
                    role="alert"
                    className="text-[12.5px] text-danger-text"
                    data-testid={`live-warning-${n.platform}`}
                  >
                    {warningNote(n.live.warning, now, n.platform)}
                  </p>
                ) : null}
                {n.live.sending === 'off' ? (
                  <p className="text-[12.5px] text-text-3">{W.sendingOffNote}</p>
                ) : null}
                {/* Its own profile to finish, when the one shown is ready: shown under its own list. */}
                {ready && !here && n.ready === false ? (
                  <p
                    className="text-[12.5px] text-text-2"
                    data-testid={`live-not-ready-${n.platform}`}
                  >
                    {READY_WORDS.stripNotReadyOn(name)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <PreDayList live={live} now={now} platform={shown.platform} />
      {steps.length ? (
        <ul
          className="grid gap-x-4 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]"
          aria-label={many ? NW.listOn(PLATFORMS[shown.platform]) : undefined}
          data-testid="today-limits"
        >
          {steps.map((step) => {
            const { done, most } = live.limits[step];
            const full = done >= most;
            return (
              <li key={step} className="grid gap-1.5" data-testid={`today-limit-${step}`}>
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="text-text-2">{words[step].label}</span>
                  <span
                    className={cn(
                      'tabular-nums',
                      full ? 'font-semibold text-warning-text' : 'font-medium',
                    )}
                  >
                    {W.countOf(done, most)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-card-2" aria-hidden="true">
                  <div
                    className={cn('h-1.5 rounded-full', full ? 'bg-warning' : 'bg-accent')}
                    style={{ width: `${Math.min(100, Math.round((done / most) * 100))}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {offline && computer ? (
        <p
          role="status"
          data-testid="live-offline"
          className="rounded-menu bg-warning-soft p-2.5 text-[12.5px] text-warning-text"
        >
          {offlineWords(computer.lastSeenAt, tz, now)}
          {open ? ` ${W.otherOpen(open.name)}` : null}
        </p>
      ) : null}
      {!many && live.warning ? (
        <p
          role="alert"
          data-testid="live-warning"
          className="rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
        >
          {warningNote(live.warning, now, shown.platform)}
        </p>
      ) : null}
      {ready ? null : (
        <p
          className="rounded-menu bg-card-2 p-2.5 text-[12.5px] text-text-2"
          data-testid="live-not-ready"
        >
          {READY_WORDS.stripNotReady}
        </p>
      )}
      {!many && live.sending === 'off' ? (
        <p
          className="rounded-menu bg-card-2 p-2.5 text-[12.5px] text-text-2"
          data-testid="live-sending-off"
        >
          {W.sendingOffNote}{' '}
          {live.canSend ? (
            <>
              {W.changeThatIn}{' '}
              <Link
                className="font-medium text-accent-text underline-offset-2 hover:underline"
                href={outreachHref(workspaceId, { view: 'settings', part: shown.platform })}
              >
                {W.tabs.settings}
              </Link>
              .
            </>
          ) : (
            W.askToSend
          )}
        </p>
      ) : null}
      {said ? (
        <p className="-mt-2 text-[12.5px] text-text-3" data-testid="live-day">
          {said}
        </p>
      ) : null}
    </Card>
  );
}
