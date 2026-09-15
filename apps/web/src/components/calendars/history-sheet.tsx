'use client';
import { RotateCcw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import type { CalendarRevision } from '@/lib/api/types';
import { dateOf, fmtMonthDay, fmtTime, todayIn } from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { labelsText } from './chips';

/** "Today, 10:12 AM" or "Sep 12". */
export function savedWhen(iso: string, timeZone: string): string {
  const d = dateOf(iso, timeZone);
  return d === todayIn(timeZone) ? `Today, ${fmtTime(iso, timeZone)}` : fmtMonthDay(d);
}

export interface RevisionEntry {
  readonly revision: number;
  /** What changed, one line each; the first is the title. */
  readonly lines: readonly string[];
  readonly labels: readonly string[];
  readonly createdAt: string;
  /** Who saved it; null when HandsFreeOS did. */
  readonly by: string | null;
}

/**
 * Every save of a builder's settings (a calendar's, the AI teammate's), newest first. Restoring saves the
 * old settings again as a new revision, so nothing is lost.
 */
export function RevisionHistorySheet({
  open,
  onOpenChange,
  subject,
  entries,
  currentRevision,
  timeZone,
  restoring,
  onRestore,
  labelsText: labelWords,
  notice,
  footer,
  testId,
  canRestore = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The line over the list (the calendar's name, "Ava · 6 revisions"). */
  subject: ReactNode;
  entries: readonly RevisionEntry[];
  currentRevision: number;
  timeZone: string;
  restoring: number | null;
  onRestore: (revision: number) => void;
  /** Stored labels as words. */
  labelsText: (tags: readonly string[]) => string;
  /** Above the list. */
  notice?: ReactNode;
  /** Under the list. */
  footer?: ReactNode;
  testId: string;
  canRestore?: boolean;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="History"
        description="Every save is kept. Restoring saves the old version as a new one, so nothing is lost."
      >
        <div className="mb-1 text-xs text-text-3">{subject}</div>
        {notice}
        <ol data-testid={testId}>
          {entries.map((r, i) => {
            const older = entries[i + 1];
            const was = older ? labelWords(older.labels) : null;
            const now = labelWords(r.labels);
            const current = r.revision === currentRevision;
            const [title, ...rest] = r.lines.length ? r.lines : ['Saved'];
            return (
              <li
                key={r.revision}
                className="flex items-start gap-3 border-t border-border py-3"
                data-testid={`revision-${r.revision}`}
              >
                <span
                  className={cn(
                    'inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-xs font-semibold',
                    current ? 'bg-accent text-white' : 'bg-card-2 text-text-2',
                  )}
                >
                  {r.revision}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[13px] font-medium">{title}</span>
                  {rest.length ? (
                    <span className="text-xs text-text-2">
                      {rest.slice(0, 3).join(' · ')}
                      {rest.length > 3 ? ` · and ${rest.length - 3} more` : ''}
                    </span>
                  ) : null}
                  <span className="text-xs text-text-3">
                    {savedWhen(r.createdAt, timeZone)} · {r.by ?? 'HandsFreeOS'}
                  </span>
                  <span className="text-xs text-text-2">
                    Labels: {was && was !== now ? `${was} → ${now}` : now}
                  </span>
                </span>
                {current ? (
                  <Badge variant="accent">Current</Badge>
                ) : canRestore ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={restoring === r.revision}
                    onClick={() => onRestore(r.revision)}
                    data-testid={`restore-${r.revision}`}
                  >
                    <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
                    Restore
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
        {footer}
      </SheetContent>
    </Sheet>
  );
}

/** Every save of a calendar, newest first. Restoring saves the old settings again as a new revision. */
export function HistorySheet({
  open,
  onOpenChange,
  calendarName,
  revisions,
  currentRevision,
  timeZone,
  restoring,
  onRestore,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  calendarName: string;
  revisions: readonly CalendarRevision[];
  currentRevision: number;
  timeZone: string;
  restoring: number | null;
  onRestore: (revision: number) => void;
}) {
  return (
    <RevisionHistorySheet
      open={open}
      onOpenChange={onOpenChange}
      subject={calendarName}
      entries={revisions.map((r) => ({
        revision: r.revision,
        lines: r.diff,
        labels: r.labels,
        createdAt: r.createdAt,
        by: r.changedBy?.fullName ?? null,
      }))}
      currentRevision={currentRevision}
      timeZone={timeZone}
      restoring={restoring}
      onRestore={onRestore}
      labelsText={labelsText}
      testId="calendar-history"
    />
  );
}
