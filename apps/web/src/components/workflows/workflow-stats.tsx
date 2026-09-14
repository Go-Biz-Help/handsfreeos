import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import type { WorkflowStats } from '@/lib/api/types';
import { cn } from '@/lib/utils';

function Tile({
  label,
  value,
  sub,
  href,
  tone,
  testId,
}: {
  label: string;
  value: number;
  sub: ReactNode;
  href?: string;
  tone?: 'warning' | 'danger';
  testId: string;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-text-3">{label}</span>
      <span
        className={cn(
          'text-[26px] font-semibold leading-tight tabular-nums tracking-[-0.01em]',
          tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : '',
        )}
      >
        {value}
      </span>
      <span className="truncate text-xs text-text-2">{sub}</span>
    </>
  );
  return (
    <Card
      className={cn(
        'min-w-0 overflow-hidden transition-colors',
        href && 'hover:border-border-strong hover:bg-card-2',
      )}
      data-testid={testId}
    >
      {href ? (
        <Link href={href} className="flex flex-col gap-0.5 px-3.5 py-3">
          {body}
        </Link>
      ) : (
        <div className="flex flex-col gap-0.5 px-3.5 py-3">{body}</div>
      )}
    </Card>
  );
}

/** Today at a glance: runs, messages sent, approvals waiting on someone, and failed runs to look at. */
export function WorkflowStatTiles({
  workspaceId,
  stats,
}: {
  workspaceId: string;
  stats: WorkflowStats;
}) {
  const runs = `/app/w/${workspaceId}/workflows/runs`;
  return (
    <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-testid="workflow-stats">
      <Tile
        label="Runs started today"
        value={stats.runsToday}
        sub={`${stats.liveRuns} going now`}
        href={`${runs}?status=waiting`}
        testId="stat-runs"
      />
      <Tile
        label="Texts and emails sent today"
        value={stats.messagesToday}
        sub={
          stats.quietHoursHeld
            ? `${stats.quietHoursHeld} waiting for quiet hours to end`
            : 'By your workflows'
        }
        testId="stat-messages"
      />
      <Tile
        label="Waiting on you"
        value={stats.approvalsPending}
        sub={
          stats.approvalsPending
            ? `Approvals: ${stats.approvalCustomers.join(', ')}`
            : 'No approvals waiting'
        }
        href={`${runs}?status=awaiting_approval`}
        tone={stats.approvalsPending ? 'warning' : undefined}
        testId="stat-approvals"
      />
      <Tile
        label="Needs a look"
        value={stats.failedRuns}
        sub={
          stats.failedWorkflow
            ? `A failed step in ${stats.failedWorkflow.name}`
            : 'No failed runs this month'
        }
        href={`${runs}?status=failed`}
        tone={stats.failedRuns ? 'danger' : undefined}
        testId="stat-failed"
      />
    </div>
  );
}
