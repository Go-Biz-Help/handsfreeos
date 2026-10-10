'use client';
/**
 * Social Outreach's Live tab (docs/outreach.md, decision 41): what the person's extension is doing right now, on which
 * computer, and what's next; Start my day and Stop for today, which reach that computer within seconds; today's counts
 * against the limits and how many messages wait for an OK; today's steps; their computers, renamable; and for owners
 * and admins, each person's status, counts and how many wait, never their lines or messages. It follows changes live,
 * and works out "offline" itself on a 30-second clock, so the note shows with no event at all. A heartbeat tells
 * nobody, so while the tab is shown it also asks again every minute, which keeps "last seen" moving: a computer still
 * beating is never called offline.
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
import { warningNote } from '@hfos/core/addons/outreach/tidy';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { outreachHref } from './address';
import type { Live, LiveTeam } from './types';
import { useAct } from './use-act';

const TONES: Record<ReturnType<typeof stateTone>, BadgeVariant> = {
  good: 'ok',
  waiting: 'accent',
  warn: 'pending',
  plain: 'gray',
};

function StateChip({ state, testId }: { state: ShownState; testId?: string }) {
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
function useServerNow(serverNow: string, everyMs = 30_000): number {
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
function useRefetchWhileShown(everyMs = LIVE_REFETCH_SECONDS * 1000): void {
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
}: {
  workspaceId: string;
  live: Live;
  /** Everyone's status, for owners and admins. */
  team: LiveTeam | null;
}) {
  useLiveRefresh(
    [
      'outreach_computer',
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
        <RightNow workspaceId={workspaceId} live={live} now={now} />
        <StepsCard live={live} />
        {team ? <TeamCard team={team} now={now} /> : null}
      </div>
      <div className="grid content-start gap-4">
        <CountsCard workspaceId={workspaceId} live={live} />
        <ComputersCard workspaceId={workspaceId} live={live} now={now} />
      </div>
    </div>
  );
}

function RightNow({ workspaceId, live, now }: { workspaceId: string; live: Live; now: number }) {
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
  const said = dayWords(live.day, tz);
  const press = (kind: 'start' | 'stop') =>
    void act(
      kind,
      async () =>
        unwrap(
          kind === 'start'
            ? await apiBrowser().POST('/v1/commands/outreach.day.start', { body: { workspaceId } })
            : await apiBrowser().POST('/v1/commands/outreach.day.stop', { body: { workspaceId } }),
        ),
      kind === 'stop'
        ? 'Stopped for today.'
        : offline || !computer
          ? 'Your day has started. Your computer begins as soon as Chrome is open.'
          : 'Your day has started. Your computer starts within seconds.',
    );
  return (
    <Card className="p-4" data-testid="live-now">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold">Right now</h3>
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
              Next step: {seenWords(status.nextAt, tz, now)}
            </p>
          ) : null}
          <p className="mt-1 text-[12.5px] text-text-3" data-testid="live-computer">
            On {computer.name} · seen {seenWords(computer.lastSeenAt, tz, now)}
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-text-2" data-testid="live-no-computer">
          Install the extension and sign in on your computer, and you’ll see here what it’s doing.
        </p>
      )}
      {offline && computer ? (
        <p
          role="status"
          data-testid="live-offline"
          className="mt-3 rounded-menu bg-warning-soft p-2.5 text-[12.5px] text-warning-text"
        >
          {offlineWords(computer.lastSeenAt, tz, now)}
          {open ? ` ${open.name} is open: open the panel there to work from it.` : null}
        </p>
      ) : null}
      {live.warning ? (
        <p
          role="alert"
          data-testid="live-warning"
          className="mt-3 rounded-menu bg-danger-soft p-2.5 text-[12.5px] text-danger-text"
        >
          {warningNote(live.warning)}
        </p>
      ) : null}
      {sendingOff ? (
        <p
          className="mt-3 rounded-menu bg-card-2 p-2.5 text-[12.5px] text-text-2"
          data-testid="live-sending-off"
        >
          The extension doesn’t work on its own for you: you do everything.{' '}
          {live.canSend ? (
            <>
              Change that in{' '}
              <Link
                className="font-medium text-accent-text underline-offset-2 hover:underline"
                href={outreachHref(workspaceId, { view: 'settings' })}
              >
                Settings
              </Link>
              .
            </>
          ) : (
            'Ask an owner of this business if you’d like it to.'
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
          Start my day
        </Button>
        <Button
          variant="secondary"
          onClick={() => press('stop')}
          loading={busy === 'stop'}
          disabled={busy !== null || stopped}
          data-testid="live-stop"
        >
          Stop for today
        </Button>
      </div>
      {said ? (
        <p className="mt-2 text-[12.5px] text-text-3" data-testid="live-day">
          {said}
        </p>
      ) : null}
    </Card>
  );
}

function CountsCard({ workspaceId, live }: { workspaceId: string; live: Live }) {
  return (
    <Card className="p-4" data-testid="live-counts">
      <h3 className="text-[15px] font-semibold">Today so far</h3>
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
              <span>{DAILY_WORDS[step].label}</span>
              <span
                className={cn(
                  'tabular-nums',
                  full ? 'font-semibold text-warning-text' : 'text-text-2',
                )}
              >
                {done} of {most}
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
            Waiting for your OK: {live.waiting} {live.waiting === 1 ? 'message' : 'messages'}
          </Link>
        </p>
      ) : null}
    </Card>
  );
}

function StepsCard({ live }: { live: Live }) {
  return (
    <Card className="p-4" data-testid="live-steps">
      <h3 className="text-[15px] font-semibold">Today’s steps</h3>
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
        <p className="mt-2 text-[13px] text-text-2">Nothing yet today.</p>
      )}
    </Card>
  );
}

function ComputersCard({
  workspaceId,
  live,
  now,
}: {
  workspaceId: string;
  live: Live;
  now: number;
}) {
  const { busy, act } = useAct();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  if (!live.computers.length) return null;
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
  return (
    <Card className="p-4" data-testid="live-computers">
      <h3 className="text-[15px] font-semibold">Your computers</h3>
      <p className="mt-0.5 text-[12.5px] text-text-3">
        The one you used last works; the others stand by. Open the panel on one to work from it.
      </p>
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
                      ? 'Signed out'
                      : c.working
                        ? 'Working for you'
                        : 'Standing by'}{' '}
                    · seen {seenWords(c.lastSeenAt, live.timezone, now)}
                  </div>
                </div>
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
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TeamCard({ team, now }: { team: LiveTeam; now: number }) {
  return (
    <Card className="p-4" data-testid="live-team">
      <h3 className="text-[15px] font-semibold">Your team</h3>
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
                        <span className="ml-1.5 text-[12px] text-danger-text">Warned</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3">
                      <StateChip state={state} />
                    </td>
                    <td className="py-2 pr-3 text-text-2">
                      {p.computer
                        ? `${p.computer.name} · ${seenWords(p.computer.lastSeenAt, team.timezone, now)}`
                        : 'None yet'}
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
        <EmptyState title="Nobody uses Social Outreach yet" dashed className="mt-3" />
      )}
    </Card>
  );
}
