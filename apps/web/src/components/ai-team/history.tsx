'use client';
import { Info, ShieldCheck } from 'lucide-react';
import { RevisionHistorySheet } from '@/components/calendars/history-sheet';
import { plural, teammateLabelsText, type ProgressView } from '@/lib/ai-team/describe';
import type { TeammateRevision, TeammateStatus } from '@/lib/ai-team/types';
import { dateOf, fmtMonthDay } from '@/lib/calendar/time';
import { Note } from './parts';

/**
 * The teammate's revisions, newest first, with what each changed (the server writes the lines with core's
 * diffTeammateConfigs). Restoring saves an old version as a new one and never touches training progress.
 */
export function TeammateHistory({
  open,
  onOpenChange,
  name,
  revisions,
  currentRevision,
  timeZone,
  restoring,
  onRestore,
  canRestore,
  progress,
  status,
  trainingStartedAt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  revisions: readonly TeammateRevision[];
  currentRevision: number;
  timeZone: string;
  restoring: number | null;
  onRestore: (revision: number) => void;
  canRestore: boolean;
  progress: ProgressView | null;
  status: TeammateStatus;
  trainingStartedAt: string | null;
}) {
  return (
    <RevisionHistorySheet
      open={open}
      onOpenChange={onOpenChange}
      subject={`${name} · ${plural(revisions.length, 'revision', 'revisions')}`}
      entries={revisions.map((r) => ({
        revision: r.revision,
        lines: r.diffSummary,
        labels: r.labels,
        createdAt: r.createdAt,
        by: r.changedBy?.fullName ?? null,
      }))}
      currentRevision={currentRevision}
      timeZone={timeZone}
      restoring={restoring}
      onRestore={onRestore}
      labelsText={teammateLabelsText}
      canRestore={canRestore}
      testId="teammate-history"
      notice={
        progress ? (
          <Note icon={ShieldCheck} className="mb-2 mt-1">
            Restoring never changes training progress. {name} stays at {progress.approved} of{' '}
            {progress.needed} approved, whichever version you restore.
          </Note>
        ) : null
      }
      footer={
        <p className="flex items-start gap-2 border-t border-border pt-3 text-xs text-text-3">
          <Info className="mt-px h-3.5 w-3.5 flex-none" strokeWidth={1.75} />
          <span>
            Turning {name} on or off and switching to automatic aren’t revisions.
            {status === 'training' && trainingStartedAt
              ? ` It’s been in training wheels since ${fmtMonthDay(dateOf(trainingStartedAt, timeZone))}.`
              : ''}
          </span>
        </p>
      }
    />
  );
}
