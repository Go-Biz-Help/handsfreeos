'use client';
/**
 * Coordinate (boards 55–58, design/realestate/CoordToday.dc.html, Exceptions, WaitingRoom and Workload): what needs
 * doing across the deals the person sees. Chris decided (2026-10-02) on four views: Today, Exceptions, the Waiting
 * room and Team workload. The round's aim is that exceptions replace checking duties by hand: each item stays until
 * it's fixed, not when someone opens it. A duty opens in the drawer, the same as on its deal.
 */
import { fmtMonthDay, localDayOf } from '@hfos/core';
import { dueWords } from '@hfos/core/addons/realestate/rule-words';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select } from '@/components/ui/input';
import { apiBrowser, unwrap } from '@/lib/api/client';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { dealHref, HealthDot, realestateHref } from './bits';
import { DutyDrawer } from './duty-drawer';
import type { Exceptions, Teammate, Today, WaitingRoom, Workload } from './types';
import { useAct } from './use-act';

export type CoordinateTab = 'today' | 'exceptions' | 'waiting' | 'workload';

const thisYear = new Date().getFullYear();

const TAGLINES: Readonly<Record<CoordinateTab, string>> = {
  today: 'what needs doing, across your deals',
  exceptions: 'what disagrees, is missing or has passed',
  waiting: 'what’s waiting on someone outside, and when to chase',
  workload: 'who has what, across every deal',
};

export function CoordinatePage({
  workspaceId,
  businessName,
  timeZone,
  tab,
  mine,
  agentUserId,
  canSeeAll,
  today,
  exceptions,
  waiting,
  workload,
  members,
}: {
  workspaceId: string;
  businessName: string;
  timeZone: string;
  tab: CoordinateTab;
  mine: boolean;
  agentUserId: string | null;
  canSeeAll: boolean;
  today: Today;
  exceptions: Exceptions;
  waiting: WaitingRoom;
  workload: Workload | null;
  members: readonly Teammate[];
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const dutyId = params.get('duty');
  const go = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    change(next);
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const openDuty = (id: string | null) =>
    go((next) => (id ? next.set('duty', id) : next.delete('duty')));
  const here = (t: CoordinateTab) => {
    const next = new URLSearchParams();
    if (t !== 'today') next.set('tab', t);
    if (mine) next.set('mine', '1');
    if (agentUserId) next.set('agent', agentUserId);
    const q = next.toString();
    return `${realestateHref(workspaceId, 'coordinate')}${q ? `?${q}` : ''}`;
  };

  const counts = {
    today: today.atRisk.length + today.overdue.length + today.dueToday.length,
    exceptions:
      exceptions.reads.length +
      exceptions.disagree.length +
      exceptions.nobodyAccountable.length +
      exceptions.noProof.length +
      exceptions.contingencies.length +
      exceptions.blocked.length,
    waiting: waiting.items.length,
  };
  const tabs: { key: CoordinateTab; label: string }[] = [
    { key: 'today', label: `Today · ${counts.today}` },
    { key: 'exceptions', label: `Exceptions · ${counts.exceptions}` },
    { key: 'waiting', label: `Waiting room · ${counts.waiting}` },
    ...(canSeeAll ? [{ key: 'workload' as const, label: 'Workload' }] : []),
  ];
  const day = new Date(`${today.today}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div data-testid="realestate-coordinate">
      <PageHeader
        title="Coordinate"
        description={`${businessName}${tab === 'today' ? ` · ${day}` : ''} · ${TAGLINES[tab]}`}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        <label className="inline-flex items-center gap-1.5">
          <span className="text-text-2">Deals:</span>
          <Select
            selectSize="sm"
            value={mine ? 'mine' : 'all'}
            onChange={(e) =>
              go((next) =>
                e.target.value === 'mine' ? next.set('mine', '1') : next.delete('mine'),
              )
            }
            aria-label="Which deals"
            data-testid="coordinate-deals"
          >
            <option value="all">All you see</option>
            <option value="mine">Mine</option>
          </Select>
        </label>
        <label className="inline-flex items-center gap-1.5">
          <span className="text-text-2">Agent:</span>
          <Select
            selectSize="sm"
            value={agentUserId ?? ''}
            onChange={(e) =>
              go((next) =>
                e.target.value ? next.set('agent', e.target.value) : next.delete('agent'),
              )
            }
            aria-label="Whose deals"
            data-testid="coordinate-agent"
          >
            <option value="">Everyone</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <Card className="overflow-hidden p-0">
        <nav
          aria-label="Coordinate"
          className="-mb-px flex flex-wrap gap-1 border-b border-border px-4 pt-2 md:px-5"
        >
          {tabs.map((t) => (
            <Link
              key={t.key}
              href={here(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              className={cn(
                'border-b-2 px-3 py-2.5 text-[14px]',
                tab === t.key
                  ? 'border-accent font-medium text-accent-text'
                  : 'border-transparent text-text-2 hover:text-text',
              )}
              data-testid={`coordinate-tab-${t.key}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        {tab === 'today' ? (
          <TodayView
            workspaceId={workspaceId}
            timeZone={timeZone}
            today={today}
            onOpen={openDuty}
          />
        ) : tab === 'exceptions' ? (
          <ExceptionsView
            workspaceId={workspaceId}
            timeZone={timeZone}
            data={exceptions}
            onOpen={openDuty}
          />
        ) : tab === 'waiting' ? (
          <WaitingView
            workspaceId={workspaceId}
            timeZone={timeZone}
            data={waiting}
            onOpen={openDuty}
          />
        ) : workload ? (
          <WorkloadView data={workload} />
        ) : null}
      </Card>

      <DutyDrawer
        workspaceId={workspaceId}
        dutyId={dutyId}
        onClose={() => openDuty(null)}
        timeZone={timeZone}
        members={members}
      />
    </div>
  );
}

/** A heading inside a view: "Overdue · 3". */
function Group({
  title,
  count,
  tone,
  children,
  testId,
}: {
  title: string;
  count: number;
  tone?: 'danger' | 'warning';
  children: ReactNode;
  testId?: string;
}) {
  if (!count) return null;
  return (
    <section data-testid={testId}>
      <h2
        className={cn(
          'border-b border-t border-border bg-card-2 px-4 py-2 text-xs font-semibold uppercase tracking-wide first:border-t-0 md:px-5',
          tone === 'danger'
            ? 'text-danger-text'
            : tone === 'warning'
              ? 'text-warning-text'
              : 'text-text-3',
        )}
      >
        {title} · {count}
      </h2>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

/** One line: what, where, and what can be done. */
function Row({
  title,
  sub,
  aside,
  actions,
  health,
  testId,
}: {
  title: ReactNode;
  sub: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  health?: 'green' | 'yellow' | 'red';
  testId?: string;
}) {
  return (
    <li
      className="flex flex-col gap-2 px-4 py-3 text-[13.5px] sm:flex-row sm:items-center md:px-5"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {health ? <HealthDot health={health} className="mt-1.5" /> : null}
        <div className="min-w-0">
          <div className="font-medium">{title}</div>
          <div className="text-[12.5px] text-text-3">{sub}</div>
        </div>
      </div>
      {aside ? (
        <div className="flex-none text-[12.5px] text-text-2 sm:text-right">{aside}</div>
      ) : null}
      {actions ? <div className="flex flex-none flex-wrap gap-2">{actions}</div> : null}
    </li>
  );
}

function OpenButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="secondary" onClick={onClick}>
      Open
    </Button>
  );
}

function OpenDeal({ href, children = 'Open' }: { href: string; children?: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex h-8 items-center rounded-control border border-border-strong bg-card px-2.5 text-[13px] shadow-1 hover:bg-card-2"
    >
      {children}
    </Link>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-10 text-center text-[13.5px] text-text-2">{children}</p>;
}

function TodayView({
  workspaceId,
  timeZone,
  today,
  onOpen,
}: {
  workspaceId: string;
  timeZone: string;
  today: Today;
  onOpen: (dutyId: string) => void;
}) {
  const { busy, act } = useAct();
  if (!today.atRisk.length && !today.overdue.length && !today.dueToday.length)
    return <Empty>Nothing at risk, overdue or due today. New work shows here as deals move.</Empty>;
  const duty = (d: Today['overdue'][number], late: boolean) => (
    <Row
      key={d.dutyId}
      testId="coordinate-today-duty"
      health={d.health}
      title={d.title}
      sub={d.dealName}
      aside={
        <>
          <div>{d.accountableName ?? 'Nobody accountable'}</div>
          <div className={late ? 'text-danger-text' : undefined}>
            {d.dueAt ? dueWords(d.dueAt, timeZone) : ''}
          </div>
        </>
      }
      actions={<OpenButton onClick={() => onOpen(d.dutyId)} />}
    />
  );
  return (
    <div>
      <Group title="At risk" count={today.atRisk.length} tone="danger" testId="coordinate-at-risk">
        {today.atRisk.map((r, i) => (
          <Row
            key={`${r.dealId}-${r.dutyId ?? i}-${r.words}`}
            testId="coordinate-risk"
            health={r.health}
            title={r.words}
            sub={
              <>
                {r.dealName}
                {r.kind === 'duty' ? (
                  <Badge variant="danger" className="ml-2">
                    Escalated
                  </Badge>
                ) : null}
                <span className="block">{r.next}</span>
              </>
            }
            actions={
              <>
                {r.kind === 'duty' && r.dutyId ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `ack-${r.dutyId}`}
                    onClick={() =>
                      void act(
                        `ack-${r.dutyId}`,
                        async () =>
                          unwrap(
                            await apiBrowser().POST('/v1/commands/realestate.duty.acknowledge', {
                              body: { workspaceId, dutyId: r.dutyId! },
                            }),
                          ),
                        'Acknowledged. Its alerts stop climbing.',
                      )
                    }
                    data-testid="coordinate-ack"
                  >
                    Acknowledge
                  </Button>
                ) : null}
                {r.dutyId ? (
                  <OpenButton onClick={() => onOpen(r.dutyId!)} />
                ) : (
                  <OpenDeal href={dealHref(workspaceId, r.dealId)} />
                )}
              </>
            }
          />
        ))}
      </Group>
      <Group title="Overdue" count={today.overdue.length} tone="danger" testId="coordinate-overdue">
        {today.overdue.map((d) => duty(d, true))}
      </Group>
      <Group title="Due today" count={today.dueToday.length} testId="coordinate-due-today">
        {today.dueToday.map((d) => duty(d, false))}
      </Group>
    </div>
  );
}

function ExceptionsView({
  workspaceId,
  timeZone,
  data,
  onOpen,
}: {
  workspaceId: string;
  timeZone: string;
  data: Exceptions;
  onOpen: (dutyId: string) => void;
}) {
  const total =
    data.reads.length +
    data.disagree.length +
    data.nobodyAccountable.length +
    data.noProof.length +
    data.contingencies.length +
    data.blocked.length;
  if (!total)
    return (
      <Empty>
        Nothing disagrees, is missing or has passed. Anything that does shows here until it’s fixed.
      </Empty>
    );
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), thisYear);
  return (
    <div>
      <Group title="Read values to confirm" count={data.reads.length} testId="exceptions-reads">
        {data.reads.map((r) => (
          <Row
            key={r.readId}
            title={`${r.dealName} · ${r.documentTitle} · ${r.waiting} ${r.waiting === 1 ? 'value' : 'values'}`}
            sub={
              r.scan
                ? 'Read from a scan, so check each value closely against its page.'
                : 'Read from the PDF’s text. Nothing counts until a person confirms it.'
            }
            aside={r.scan ? <Badge variant="pending">Read from a scan</Badge> : null}
            actions={
              <OpenDeal href={dealHref(workspaceId, r.dealId, `contract/${r.readId}`)}>
                Check them
              </OpenDeal>
            }
          />
        ))}
      </Group>
      <Group
        title="Dates or terms that disagree"
        count={data.disagree.length}
        tone="warning"
        testId="exceptions-disagree"
      >
        {data.disagree.map((r, i) => (
          <Row
            key={`${r.dealId}-${i}`}
            title={`${r.dealName}: ${r.words}`}
            sub={r.next}
            aside={r.linked ? <Badge variant="gray">Linked deal</Badge> : null}
            actions={<OpenDeal href={dealHref(workspaceId, r.dealId)} />}
          />
        ))}
      </Group>
      <Group
        title="Contingencies past their end"
        count={data.contingencies.length}
        tone="danger"
        testId="exceptions-contingencies"
      >
        {data.contingencies.map((c) => (
          <Row
            key={c.contingencyId}
            title={`${c.dealName} · ${c.label}`}
            sub={`Ended ${fmtMonthDay(c.endedOn, thisYear)} and nothing is recorded. Record whether it was satisfied, waived or expired.`}
            actions={
              <OpenDeal href={dealHref(workspaceId, c.dealId, 'contingencies')}>Record it</OpenDeal>
            }
          />
        ))}
      </Group>
      <Group
        title="Nobody accountable"
        count={data.nobodyAccountable.length}
        testId="exceptions-nobody"
      >
        {data.nobodyAccountable.map((d) => (
          <Row
            key={d.dutyId}
            title={`${d.dealName} · ${d.title}`}
            sub="Nobody answers for it. Pick who has it now."
            actions={
              <Button size="sm" variant="secondary" onClick={() => onOpen(d.dutyId)}>
                Give it to…
              </Button>
            }
          />
        ))}
      </Group>
      <Group title="Due soon without proof" count={data.noProof.length} testId="exceptions-proof">
        {data.noProof.map((d) => (
          <Row
            key={d.dutyId}
            title={`${d.dealName} · ${d.title}`}
            sub={`${d.dueAt ? `${dueWords(d.dueAt, timeZone)[0]!.toUpperCase()}${dueWords(d.dueAt, timeZone).slice(1)}` : 'No deadline'}. Its proof isn’t attached yet.`}
            aside={d.accountableName ?? 'Nobody accountable'}
            actions={<OpenButton onClick={() => onOpen(d.dutyId)} />}
          />
        ))}
      </Group>
      <Group
        title="Blocked past its review time"
        count={data.blocked.length}
        testId="exceptions-blocked"
      >
        {data.blocked.map((d) => (
          <Row
            key={d.dutyId}
            title={`${d.dealName} · ${d.title}`}
            sub={`Blocked: ${d.blocker}${d.owner ? `, ${d.owner} to clear it` : ''}; it was to be looked at again ${day(d.reviewAt)}.`}
            actions={<OpenButton onClick={() => onOpen(d.dutyId)} />}
          />
        ))}
      </Group>
      <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
        Each item stays here until it’s fixed, not when someone opens it. Nothing here is a duty:
        it’s what the duties can’t tell you.
      </p>
    </div>
  );
}

function WaitingView({
  workspaceId,
  timeZone,
  data,
  onOpen,
}: {
  workspaceId: string;
  timeZone: string;
  data: WaitingRoom;
  onOpen: (dutyId: string) => void;
}) {
  const { busy, act } = useAct();
  if (!data.items.length)
    return <Empty>Nothing is waiting on anyone outside, and nothing is blocked.</Empty>;
  const day = (iso: string) => fmtMonthDay(localDayOf(iso, timeZone), thisYear);
  const todayIs = localDayOf(new Date().toISOString(), timeZone);
  const api = apiBrowser();
  return (
    <div>
      <ul className="divide-y divide-border" data-testid="waiting-room">
        {data.items.map((w) => {
          const next = w.next ? localDayOf(w.next, timeZone) : null;
          return (
            <Row
              key={w.dutyId}
              testId="waiting-item"
              title={
                <button
                  type="button"
                  className="text-left hover:underline"
                  onClick={() => onOpen(w.dutyId)}
                >
                  {w.title}
                </button>
              }
              sub={
                <>
                  <Link href={dealHref(workspaceId, w.dealId)} className="hover:underline">
                    {w.dealName}
                  </Link>
                  {' · '}
                  {w.status === 'blocked' ? `Blocked: ${w.blocker ?? ''}; ` : ''}
                  {w.status === 'blocked'
                    ? `${w.waitingOn} to clear it`
                    : `Waiting on ${w.waitingOn}`}
                  {' since '}
                  {day(w.since)}
                </>
              }
              aside={
                next ? (
                  <span className={w.past ? 'font-medium text-danger-text' : undefined}>
                    {w.status === 'blocked' ? 'Review ' : 'Chase '}
                    {next === todayIs ? 'today' : w.past ? `was ${day(w.next!)}` : day(w.next!)}
                  </span>
                ) : null
              }
              actions={
                <>
                  {w.status === 'waiting_external' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy === `chased-${w.dutyId}`}
                      onClick={() =>
                        void act(
                          `chased-${w.dutyId}`,
                          async () =>
                            unwrap(
                              await api.POST('/v1/commands/realestate.duty.chased', {
                                body: { workspaceId, dutyId: w.dutyId },
                              }),
                            ),
                          'Noted. Chase them again in two business days.',
                        )
                      }
                      data-testid="waiting-chased"
                    >
                      Chased
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `in-${w.dutyId}`}
                    onClick={() =>
                      void act(
                        `in-${w.dutyId}`,
                        async () =>
                          unwrap(
                            await api.POST('/v1/commands/realestate.duty.set_status', {
                              body: { workspaceId, dutyId: w.dutyId, status: 'in_progress' },
                            }),
                          ),
                        w.status === 'blocked'
                          ? 'Not blocked anymore.'
                          : 'Not waiting anymore. Add the proof on the duty.',
                      )
                    }
                    data-testid="waiting-came-in"
                  >
                    {w.status === 'blocked' ? 'It’s clear' : 'It came in'}
                  </Button>
                </>
              }
            />
          );
        })}
      </ul>
      <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
        “Chased” sets the next chase two business days on. Past its chase date, a wait turns the
        deal yellow. “It came in” clears the wait; add the proof on the duty.
      </p>
    </div>
  );
}

function WorkloadView({ data }: { data: Workload }) {
  if (!data.people.length) return <Empty>Nobody on the team has deals yet.</Empty>;
  const most = Math.max(1, ...data.people.map((p) => p.openDuties));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[13.5px]" data-testid="workload">
        <thead>
          <tr className="text-left text-xs font-semibold uppercase tracking-wide text-text-3">
            <th className="px-5 py-2.5 font-semibold">Person</th>
            <th className="px-3 py-2.5 text-right font-semibold">Deals</th>
            <th className="px-3 py-2.5 text-right font-semibold">Open duties</th>
            <th className="px-3 py-2.5 text-right font-semibold">Overdue</th>
            <th className="px-3 py-2.5 text-right font-semibold">Due in 2 days</th>
            <th className="px-3 py-2.5 text-right font-semibold">Deals at risk</th>
            <th className="w-[180px] px-5 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {data.people.map((p) => (
            <tr key={p.userId} className="border-t border-border" data-testid="workload-person">
              <td className="px-5 py-3">
                <div className="font-medium">{p.name}</div>
                <div className="text-[12.5px] capitalize text-text-3">{p.role}</div>
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{p.deals}</td>
              <td className="px-3 py-3 text-right tabular-nums">{p.openDuties}</td>
              <td
                className={cn(
                  'px-3 py-3 text-right tabular-nums',
                  p.overdue && 'font-semibold text-danger-text',
                )}
              >
                {p.overdue}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{p.dueSoon}</td>
              <td
                className={cn(
                  'px-3 py-3 text-right tabular-nums',
                  p.atRiskDeals && 'font-semibold text-danger-text',
                )}
              >
                {p.atRiskDeals}
              </td>
              <td className="px-5 py-3">
                <div className="flex items-center">
                  <div
                    className="flex h-2 flex-1 overflow-hidden rounded-full bg-card-2"
                    title={`${p.overdue} overdue, ${p.dueSoon} due in 2 days, ${p.openDuties} open`}
                  >
                    <span className="bg-danger" style={{ width: `${(p.overdue / most) * 100}%` }} />
                    <span
                      className="bg-warning"
                      style={{ width: `${(p.dueSoon / most) * 100}%` }}
                    />
                    <span
                      className="bg-accent"
                      style={{
                        width: `${(Math.max(0, p.openDuties - p.overdue - p.dueSoon) / most) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-border px-5 py-3 text-[12.5px] text-text-3">
        Red is overdue, yellow due within two business days, blue the rest. Give a duty to someone
        else from its drawer.
      </p>
    </div>
  );
}
