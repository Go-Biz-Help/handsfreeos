'use client';
/**
 * What the person's extension is doing, in the parts Today and Settings share (docs/outreach.md, decisions 41 and 127:
 * the Details page folded into them). Today has a card for each network (./status-strip.tsx), Done today and, for owners
 * and admins, each person's status, counts and how many wait, never their lines or messages (`TeamCard`). Settings →
 * Your computer has the person's computers, renamable and removable, one or every one standing by (decision 85;
 * `ComputersCard`), and what they asked their computer to do (`AskedCard`). Each follows changes live, and works out
 * "offline" itself on a 30-second clock (`useServerNow`), so the note shows with no event at all. A heartbeat tells
 * nobody, so while Today is shown it also asks again every minute (`useRefetchWhileShown`), which keeps "last seen"
 * moving: a computer still beating is never called offline.
 */
import { ASK_WORDS } from '@hfos/core/addons/outreach/asks';
import { DAILY_STEPS, DAILY_WORDS } from '@hfos/core/addons/outreach/limits';
import {
  COMPUTER_NAME_MOST,
  isOffline,
  LIVE_REFETCH_SECONDS,
  seenWords,
  SHOWN_STATES,
  shownState,
  stateTone,
  type ShownState,
} from '@hfos/core/addons/outreach/live';
import { teamWordsOn } from '@hfos/core/addons/outreach/network-words';
import {
  foldAsks,
  sameSince,
  SETTINGS_PAGE_WORDS as SP,
} from '@hfos/core/addons/outreach/settings-pages';
import { OUTREACH_WORDS as W } from '@hfos/core/addons/outreach/words';
import { ChevronDown, Monitor } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { AskLine } from './asks';
import type { Asks, Live, LiveTeam } from './types';
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

/**
 * What the person asked their computer to do from the other pages, today's and the open ones, each as it goes: on
 * Settings → Your computer (decision 127). The ones that ended the same way fold under the newest, with how many more
 * and since when (decision 170, part 2).
 */
export function AskedCard({
  workspaceId,
  asks,
  className,
}: {
  workspaceId: string;
  asks: Asks;
  className?: string;
}) {
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const now = Date.parse(asks.now);
  const folded = foldAsks(asks.asks);
  return (
    <Card
      className={cn('px-[22px] py-5 max-md:px-4 max-md:py-4', className)}
      data-testid="live-asks"
    >
      <h3 className="text-[16px] font-semibold tracking-tight">{SP.asked}</h3>
      {folded.length ? (
        <ul className="mt-3 grid gap-2">
          {folded.map(({ ask, same }) => {
            const open = shown.has(ask.askId);
            return (
              <li key={ask.askId} className="grid gap-2" data-testid="live-ask">
                <AskLine workspaceId={workspaceId} asks={asks} ask={ask} named />
                {same.length ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setShown((s) => {
                        const next = new Set(s);
                        if (open) next.delete(ask.askId);
                        else next.add(ask.askId);
                        return next;
                      })
                    }
                    className="flex min-h-[40px] items-center justify-between gap-3 rounded-menu bg-card-2 px-3.5 text-left text-[13px] text-text-2 hover:bg-card-3 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                    data-testid="live-ask-same"
                  >
                    {SP.same(same.length, sameSince(same, asks.timezone, now))}
                    <ChevronDown
                      className={cn('h-4 w-4 flex-none transition-transform', open && 'rotate-180')}
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  </button>
                ) : null}
                {open
                  ? same.map((a) => (
                      <AskLine key={a.askId} workspaceId={workspaceId} asks={asks} ask={a} named />
                    ))
                  : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-2 text-[13px] text-text-2" data-testid="live-asks-empty">
          {ASK_WORDS.askedNone}
        </p>
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

/**
 * How each person's extension is doing today on one network, for owners and admins (decision 24): on Today, below the
 * person's own (decision 127). Never their lines or messages.
 */
export function TeamCard({ team, className }: { team: LiveTeam; className?: string }) {
  const now = useServerNow(team.now);
  const words = teamWordsOn(team.platform);
  return (
    <Card className={cn('p-4', className)} data-testid="live-team">
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

/**
 * Settings → Your computer's first card (decision 170, part 2): the computer that works for the person, whether it's
 * online, its build and when it was last seen, with Rename and the extension's download; the others standing by fold
 * under it, to remove.
 */
export function ComputerMain({
  workspaceId,
  live,
  download,
}: {
  workspaceId: string;
  live: Live;
  /** The extension's download and how to install it. */
  download: React.ReactNode;
}) {
  const now = useServerNow(live.now);
  const { busy, act } = useAct();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [getting, setGetting] = useState(false);
  const [others, setOthers] = useState(false);
  const main = live.computers.find((c) => c.working) ?? live.computers[0];
  if (!main)
    return (
      <Card className="space-y-3 p-5 max-md:p-4" data-testid="outreach-computer-main">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-card-2 text-text-2">
            <Monitor className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="text-[17px] font-semibold">{SP.noComputer}</div>
            <p className="text-[13.5px] text-text-2">{W.noComputer}</p>
          </div>
        </div>
        {download}
      </Card>
    );
  const signedOut = main.state === 'signed_out';
  const offline = !signedOut && isOffline(main.lastSeenAt, now);
  const tone = signedOut || offline ? 'warn' : 'good';
  const rest = live.computers.filter((c) => c.id !== main.id);
  return (
    <Card className="space-y-3.5 p-5 max-md:p-4" data-testid="outreach-computer-main">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'inline-flex h-9 w-9 flex-none items-center justify-center rounded-[10px]',
            tone === 'good'
              ? 'bg-success-soft text-success-text'
              : 'bg-warning-soft text-warning-text',
          )}
        >
          <Monitor className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-[17px] font-semibold" data-testid="outreach-computer-main-title">
              {signedOut
                ? SP.signedOut(main.name)
                : offline
                  ? SP.offline(main.name)
                  : SP.working(main.name)}
            </span>
            <Badge
              variant={tone === 'good' ? 'ok' : 'pending'}
              data-testid="outreach-computer-main-chip"
            >
              {signedOut ? SP.chips.signedOut : offline ? SP.chips.offline : SP.chips.online}
            </Badge>
          </div>
          <p className="text-[13.5px] text-text-2" data-testid="outreach-computer-main-line">
            {SP.computerLine(main.version, seenWords(main.lastSeenAt, live.timezone, now))}
          </p>
        </div>
      </div>
      {renaming ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              `rename:${main.id}`,
              async () =>
                unwrap(
                  await apiBrowser().POST('/v1/commands/outreach.computer.rename', {
                    body: { workspaceId, computerId: main.id, name },
                  }),
                ),
              'Renamed.',
            ).then((ok) => ok && setRenaming(false));
          }}
        >
          <Input
            className="min-w-0 flex-1"
            aria-label="Computer name"
            value={name}
            maxLength={COMPUTER_NAME_MOST}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Button type="submit" size="sm" loading={busy === `rename:${main.id}`}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setName(main.name);
              setRenaming(true);
            }}
            data-testid="outreach-computer-main-rename"
          >
            {SP.rename}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={getting}
            onClick={() => setGetting((g) => !g)}
            data-testid="outreach-computer-main-download"
          >
            {getting ? SP.hide : SP.download}
          </Button>
        </div>
      )}
      {getting ? download : null}
      {rest.length ? (
        <div className="border-t border-border pt-3">
          <div className="flex items-center justify-between gap-3 text-[13px] text-text-2">
            <span>{SP.standingBy(rest.length)}</span>
            <button
              type="button"
              aria-expanded={others}
              onClick={() => setOthers((o) => !o)}
              className="font-medium text-accent-text hover:underline"
              data-testid="outreach-computer-main-others"
            >
              {others ? SP.hide : SP.show}
            </button>
          </div>
          {others ? (
            <div className="mt-3">
              <ComputersCard workspaceId={workspaceId} live={live} now={now} bare />
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
