'use client';
/**
 * The top of Today (docs/outreach.md, decisions 41 and 59): what the person's computer is doing, what's next, today's
 * steps against the daily limits, and Start my day and Stop for today, in one strip, so nobody opens another tab to
 * see whether it's working. Offline, a Facebook warning, and Sending off each say so in a line. **Details** opens the
 * full day (./live-view.tsx): the feed, what was asked of the computer, the team, and renaming computers.
 */
import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  dayWords,
  isOffline,
  offlineWords,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
} from '@hfos/core/addons/outreach/live';
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

export function StatusStrip({ workspaceId, live }: { workspaceId: string; live: Live }) {
  useRefetchWhileShown();
  const now = useServerNow(live.now);
  const { busy, act } = useAct();
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
  const sendingOff = live.sending === 'off';
  const started = live.day.state === 'started';
  const stopped = live.day.state === 'stopped';
  const said = dayWords(live.day, tz, live.lists);
  const line =
    computer && live.status?.line && !offline && state !== 'signed_out' ? live.status.line : null;
  const next =
    computer && live.status?.nextAt && state === 'waiting'
      ? seenWords(live.status.nextAt, tz, now)
      : null;
  const press = (kind: 'start' | 'stop') =>
    void act(
      kind,
      async () =>
        unwrap(
          kind === 'start'
            ? await apiBrowser().POST('/v1/commands/outreach.day.start', { body: { workspaceId } })
            : await apiBrowser().POST('/v1/commands/outreach.day.stop', { body: { workspaceId } }),
        ),
      kind === 'stop' ? W.stopped : W.started(!offline && computer !== null),
    );
  const steps = DAILY_STEPS.filter((s) => live.limits[s].most > 0);
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
                href={`${outreachHref(workspaceId, { view: 'settings' })}#computer`}
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
          {started ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => press('stop')}
              loading={busy === 'stop'}
              disabled={busy !== null || stopped}
              data-testid="live-stop"
            >
              {W.stopDay}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => press('start')}
              loading={busy === 'start'}
              disabled={busy !== null || sendingOff || live.day.why === 'warning'}
              data-testid="live-start"
            >
              {W.startDay}
            </Button>
          )}
          <Link
            href={outreachHref(workspaceId, { view: 'live' })}
            className="px-1 text-[13px] font-medium text-accent-text hover:underline"
            data-testid="today-status-details"
          >
            {W.computerDetails}
          </Link>
        </div>
      </div>
      <PreDayList live={live} now={now} />
      {steps.length ? (
        <ul
          className="grid gap-x-4 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]"
          data-testid="today-limits"
        >
          {steps.map((step) => {
            const { done, most } = live.limits[step];
            const full = done >= most;
            return (
              <li key={step} className="grid gap-1.5" data-testid={`today-limit-${step}`}>
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="text-text-2">{DAILY_WORDS[step].label}</span>
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
      {live.warning ? (
        <p
          role="alert"
          data-testid="live-warning"
          className="rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
        >
          {warningNote(live.warning)}
        </p>
      ) : null}
      {sendingOff ? (
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
                href={outreachHref(workspaceId, { view: 'settings' })}
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
