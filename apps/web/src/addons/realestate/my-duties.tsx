'use client';
/**
 * My duties: everything the person answers for across their deals, most urgent first: overdue, today, this week and
 * later, then what's waiting on someone, what's blocked, and duties waiting for a date to be confirmed. A duty opens
 * in the drawer, the same as on its deal.
 */
import { dueWords } from '@hfos/core/addons/realestate/rule-words';
import { localDateOf, daysBetween } from '@hfos/core';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn } from '@/lib/utils';
import { dealHref, DutyStatusBadge } from './bits';
import { DutyDrawer } from './duty-drawer';
import type { DutyRow, Teammate } from './types';

export function MyDuties({
  workspaceId,
  timeZone,
  scope,
  duties,
  drafts,
  members,
  canSeeAll,
}: {
  workspaceId: string;
  timeZone: string;
  scope: 'mine' | 'all';
  duties: readonly DutyRow[];
  drafts: readonly DutyRow[];
  members: readonly Teammate[];
  canSeeAll: boolean;
}) {
  useLiveRefresh(['custom_record']);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const dutyId = params.get('duty');
  const go = (next: URLSearchParams) => {
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const open = (id: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('duty', id);
    else next.delete('duty');
    go(next);
  };

  const groups = useMemo(() => {
    const now = Date.now();
    const today = localDateOf(now, timeZone);
    const g: Record<string, DutyRow[]> = {
      overdue: [],
      today: [],
      week: [],
      later: [],
      none: [],
      waiting: [],
      blocked: [],
    };
    const sorted = [...duties].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999'));
    for (const d of sorted) {
      if (d.status === 'waiting_external') g.waiting!.push(d);
      else if (d.status === 'blocked') g.blocked!.push(d);
      else if (!d.dueAt) g.none!.push(d);
      else if (d.overdue) g.overdue!.push(d);
      else {
        const days = daysBetween(today, localDateOf(Date.parse(d.dueAt), timeZone));
        (days <= 0 ? g.today! : days < 7 ? g.week! : g.later!).push(d);
      }
    }
    return g;
  }, [duties, timeZone]);

  const sections: { key: string; title: string; list: readonly DutyRow[] }[] = [
    { key: 'overdue', title: 'Overdue', list: groups.overdue! },
    { key: 'today', title: 'Today', list: groups.today! },
    { key: 'week', title: 'This week', list: groups.week! },
    { key: 'later', title: 'Later', list: groups.later! },
    { key: 'none', title: 'No deadline', list: groups.none! },
    { key: 'waiting', title: 'Waiting on someone', list: groups.waiting! },
    { key: 'blocked', title: 'Blocked', list: groups.blocked! },
    { key: 'drafts', title: 'Waiting for a date to be confirmed', list: drafts },
  ].filter((s) => s.list.length);

  return (
    <div data-testid="realestate-my-duties">
      <PageHeader
        title={scope === 'mine' ? 'My duties' : 'Everyone’s duties'}
        description={
          duties.length
            ? `${duties.length} open${groups.overdue!.length ? ` · ${groups.overdue!.length} overdue` : ''}`
            : 'Nothing open.'
        }
        actions={
          canSeeAll ? (
            <Segmented
              value={scope}
              onChange={(v) => {
                const next = new URLSearchParams(params.toString());
                if (v === 'all') next.set('scope', 'all');
                else next.delete('scope');
                next.delete('duty');
                go(next);
              }}
              options={[
                { value: 'mine', label: 'Mine' },
                { value: 'all', label: 'Everyone’s' },
              ]}
              ariaLabel="Whose duties"
            />
          ) : null
        }
      />
      {sections.length === 0 ? (
        <Card className="px-6 py-10 text-center text-[13.5px] text-text-2">
          Nothing to do. New duties show here as your deals move.
        </Card>
      ) : (
        <div className="space-y-4">
          {sections.map((s) => (
            <Card key={s.key} className="p-0" data-testid={`duties-${s.key}`}>
              <h2
                className={cn(
                  'border-b border-border px-5 py-2.5 text-xs font-semibold uppercase tracking-wide',
                  s.key === 'overdue' ? 'text-danger-text' : 'text-text-3',
                )}
              >
                {s.title} · {s.list.length}
              </h2>
              <ul className="divide-y divide-border">
                {s.list.map((d) => (
                  <li key={d.dutyId}>
                    <button
                      type="button"
                      onClick={() => open(d.dutyId)}
                      className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-card-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px]">{d.title}</div>
                        <div className="truncate text-[12.5px] text-text-3">
                          <Link
                            href={dealHref(workspaceId, d.dealId)}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {d.dealName}
                          </Link>
                          {scope === 'all' && d.accountable ? ` · ${d.accountable.name}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-none flex-col items-end gap-1 text-[12.5px]">
                        {d.status !== 'not_started' && d.status !== 'in_progress' ? (
                          <DutyStatusBadge status={d.status} overdue={false} />
                        ) : null}
                        <span className={d.overdue ? 'text-danger-text' : 'text-text-2'}>
                          {d.dueAt ? dueWords(d.dueAt, timeZone) : ''}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
      <DutyDrawer
        workspaceId={workspaceId}
        dutyId={dutyId}
        onClose={() => open(null)}
        timeZone={timeZone}
        members={members}
      />
    </div>
  );
}
