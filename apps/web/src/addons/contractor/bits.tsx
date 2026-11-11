'use client';
/**
 * Small pieces the add-on's pages share: where its pages are, a job's status as a badge, % done as a bar, and its
 * deadline in words.
 */
import { checklistWords, type ChecklistProgress } from '@hfos/core/addons/contractor/checklists';
import type { JobStatus, PhaseStatus } from '@hfos/core/addons/contractor/progress';
import type { VisitStage } from '@hfos/core/addons/contractor/schemas';
import {
  CONTRACTOR_WORDS,
  dueWords,
  JOB_STATUS_WORDS,
  lateWords,
  PHASE_STATUS_WORDS,
  VISIT_STAGE_WORDS,
} from '@hfos/core/addons/contractor/words';
import { formatDateOnly } from '@hfos/core';
import { ListChecks } from 'lucide-react';
import { Badge, type BadgeVariant } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const contractorHref = (workspaceId: string, path = '') =>
  `/app/w/${workspaceId}/a/contractor${path ? `/${path}` : ''}`;
export const jobHref = (workspaceId: string, jobId: string) =>
  contractorHref(workspaceId, `jobs/${jobId}`);
/** A visit's work order. */
export const workOrderHref = (workspaceId: string, appointmentId: string) =>
  contractorHref(workspaceId, `visits/${appointmentId}`);
/** Core's page for the job's record: its notes, files, tasks and timeline. */
export const jobRecordHref = (workspaceId: string, jobId: string) =>
  `/app/w/${workspaceId}/customers/records/${jobId}`;

const STATUS_BADGE: Readonly<Record<JobStatus, BadgeVariant>> = {
  new: 'gray',
  scheduled: 'accent',
  in_progress: 'pending',
  on_hold: 'danger',
  done: 'ok',
  cancelled: 'member',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <Badge variant={STATUS_BADGE[status]} data-testid="job-status">
      {JOB_STATUS_WORDS[status]}
    </Badge>
  );
}

const STAGE_BADGE: Readonly<Record<VisitStage, BadgeVariant>> = {
  scheduled: 'accent',
  on_the_way: 'pending',
  in_progress: 'pending',
  waiting_on_parts: 'danger',
  done: 'ok',
  cancelled: 'member',
};

/** Where a visit stands, as its crew set it: scheduled, on the way, started, done. */
export function StageBadge({ stage }: { stage: VisitStage }) {
  return (
    <Badge variant={STAGE_BADGE[stage]} data-testid="visit-stage">
      {VISIT_STAGE_WORDS[stage]}
    </Badge>
  );
}

/** A visit's checklist in a line: "3 of 5 done · 1 required left", in red while a required item is left. */
export function ChecklistLine({ checklist }: { checklist: ChecklistProgress | null }) {
  if (!checklist)
    return <span className="text-text-3">{CONTRACTOR_WORDS.dispatch.noWorkOrder}</span>;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1',
        checklist.requiredLeft ? 'text-danger-text' : 'text-text-2',
      )}
    >
      <ListChecks className="h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
      {checklistWords(checklist)}
    </span>
  );
}

const PHASE_BADGE: Readonly<Record<PhaseStatus, BadgeVariant>> = {
  not_started: 'gray',
  in_progress: 'pending',
  done: 'ok',
};

export function PhaseBadge({ status }: { status: PhaseStatus }) {
  return <Badge variant={PHASE_BADGE[status]}>{PHASE_STATUS_WORDS[status]}</Badge>;
}

/** % done as a thin bar, with its number beside it. */
export function PercentBar({
  percent,
  className,
  late,
}: {
  percent: number;
  className?: string;
  late?: boolean;
}) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-card-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label={`${percent}% done`}
      >
        <div
          className={cn(
            'h-full rounded-full',
            percent >= 100 ? 'bg-success' : late ? 'bg-danger' : 'bg-accent',
          )}
          style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
        />
      </div>
      <span className="w-9 flex-none text-right text-[12px] tabular-nums text-text-2">
        {percent}%
      </span>
    </div>
  );
}

/** Days from `today` to `day`, both `YYYY-MM-DD`. */
function daysFrom(today: string, day: string): number {
  return Math.round(
    (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

/** "Due in 4 days" · "2 days late" · "Due Nov 14", for an open job or phase with a deadline. */
export function DueLine({
  dueOn,
  daysLate,
  today,
  finished,
}: {
  dueOn: string | null;
  daysLate: number | null;
  today: string;
  finished: boolean;
}) {
  if (!dueOn) return null;
  if (finished) return <span className="text-text-3">Deadline {formatDateOnly(dueOn)}</span>;
  if (daysLate && daysLate > 0)
    return <span className="font-medium text-danger-text">{lateWords(daysLate)}</span>;
  const left = daysFrom(today, dueOn);
  return (
    <span className={cn(left <= 2 ? 'text-warning-text' : 'text-text-2')}>
      {left <= 14 ? dueWords(left) : `Due ${formatDateOnly(dueOn)}`}
    </span>
  );
}
