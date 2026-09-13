'use client';
import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { TaskList } from '@/components/tasks/task-list';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { Appointment, AuditEntry, CrmSummary, LeadCard, Task } from '@/lib/api/types';
import { describeAudit } from '@/lib/audit-describe';
import { formatMoney } from '@/lib/format';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { cn, relativeTime } from '@/lib/utils';
import { TodayCard } from './today-card';

/** The workspace home once there are customers: numbers that matter today, my tasks, leads going cold, recent activity. */
export function HomeSummary({
  workspaceId,
  summary,
  tasks,
  coldLeads,
  recent,
  members,
  myUserId,
  canModerate,
  today,
}: {
  workspaceId: string;
  summary: CrmSummary;
  tasks: Task[];
  coldLeads: LeadCard[];
  recent: AuditEntry[];
  members: { id: string; fullName: string }[];
  myUserId: string;
  canModerate: boolean;
  /** The Today card: today's and tomorrow's appointments, in the workspace's zone. */
  today?: { timeZone: string; date: string; tomorrow: string; items: Appointment[] } | null;
}) {
  useLiveRefresh();
  const base = `/app/w/${workspaceId}`;
  const stats: { label: string; value: string; tone?: string; href: string; warn?: boolean }[] = [
    {
      label: `Open leads · ${formatMoney(summary.openValueCents)}`,
      value: String(summary.openLeads),
      href: `${base}/pipeline`,
    },
    {
      label: 'Leads without a next action',
      value: String(summary.leadsWithoutNextAction),
      tone: summary.leadsWithoutNextAction ? 'text-warning-text' : '',
      href: `${base}/pipeline?view=list`,
      warn: summary.leadsWithoutNextAction > 0,
    },
    { label: 'Tasks due today', value: String(summary.tasksDueToday), href: `${base}/tasks` },
    {
      label: 'Overdue',
      value: String(summary.tasksOverdue),
      tone: summary.tasksOverdue ? 'text-danger-text' : '',
      href: `${base}/tasks`,
    },
  ];
  return (
    <div className="flex flex-col gap-5" data-testid="home-summary">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
        {stats.map((s) => (
          <Link
            key={s.label}
            href={s.href}
            className={cn(
              'rounded-card border bg-card p-4 shadow-1 transition-colors hover:bg-card-2',
              s.warn ? 'border-warning' : 'border-border',
            )}
          >
            <div className={cn('text-2xl font-semibold tracking-tight', s.tone)}>{s.value}</div>
            <div className="text-[13px] text-text-2">{s.label}</div>
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
        {today ? (
          <TodayCard
            workspaceId={workspaceId}
            timeZone={today.timeZone}
            today={today.date}
            tomorrow={today.tomorrow}
            items={today.items}
            myUserId={myUserId}
          />
        ) : null}
        <Card>
          <div className="flex items-center justify-between px-5 pt-4 md:px-6">
            <h2 className="text-lg font-semibold tracking-tight">My tasks</h2>
            <Link
              href={`${base}/tasks`}
              className="text-[13px] font-medium text-accent-text hover:underline"
            >
              All tasks
            </Link>
          </div>
          <TaskList
            workspaceId={workspaceId}
            tasks={tasks}
            members={members}
            myUserId={myUserId}
            canModerate={canModerate}
            showRelated
            emptyTitle="Nothing on your list"
            emptyHint="Tasks assigned to you show up here."
          />
        </Card>
        <div
          className={cn(
            'flex flex-col gap-5',
            today && 'lg:col-span-2 lg:grid lg:grid-cols-2 lg:items-start',
          )}
        >
          <Card className="p-5">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-[15px] font-semibold">Needs a next action</h3>
              {coldLeads.length ? <Badge variant="pending">{coldLeads.length}</Badge> : null}
            </div>
            {coldLeads.length === 0 ? (
              <p className="text-[13px] text-text-2">Every open lead has a next step. Nice.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {coldLeads.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-3">
                    <Link
                      href={`${base}/leads/${l.id}`}
                      className="flex min-w-0 flex-col hover:underline"
                    >
                      <span className="truncate text-[13px] font-semibold">
                        {l.title} · {l.person?.fullName ?? l.company?.name ?? ''}
                      </span>
                      <span className="text-xs text-text-3">
                        {l.stageName} · {relativeTime(l.stageEnteredAt)}
                      </span>
                    </Link>
                    <span className="inline-flex flex-none items-center gap-1 rounded-[7px] bg-warning-soft px-2 py-1 text-xs font-medium text-warning-text">
                      <AlertTriangle className="h-3.5 w-3.5" strokeWidth={1.75} />
                      No follow-up
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card className="p-5">
            <h3 className="mb-2.5 text-[15px] font-semibold">Recent activity</h3>
            {recent.length === 0 ? (
              <p className="text-[13px] text-text-2">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {recent.map((e) => {
                  const name =
                    e.actor.type === 'system' ? 'HandsFreeOS' : (e.actor.fullName ?? 'Someone');
                  return (
                    <li key={e.id} className="flex items-start gap-2.5 text-[13px]">
                      <Avatar
                        name={name}
                        seed={e.actor.userId ?? 'system'}
                        size="sm"
                        className={e.actor.type === 'system' ? 'bg-[#5b616a]' : undefined}
                      />
                      <span className="min-w-0">
                        <strong className="font-semibold">
                          {e.actor.userId === myUserId ? 'You' : name}
                        </strong>{' '}
                        {describeAudit(e)} ·{' '}
                        <span className="text-text-3">{relativeTime(e.createdAt)}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
