'use client';
import { RotateCcw } from 'lucide-react';
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title="History"
        description="Every save is kept. Restoring saves the old version as a new one, so nothing is lost."
      >
        <div className="mb-1 text-xs text-text-3">{calendarName}</div>
        <ol data-testid="calendar-history">
          {revisions.map((r, i) => {
            const older = revisions[i + 1];
            const was = older ? labelsText(older.labels) : null;
            const now = labelsText(r.labels);
            const current = r.revision === currentRevision;
            const [title, ...rest] = r.diff.length ? r.diff : ['Saved'];
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
                    {savedWhen(r.createdAt, timeZone)} · {r.changedBy?.fullName ?? 'HandsFreeOS'}
                  </span>
                  <span className="text-xs text-text-2">
                    Labels: {was && was !== now ? `${was} → ${now}` : now}
                  </span>
                </span>
                {current ? (
                  <Badge variant="accent">Current</Badge>
                ) : (
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
                )}
              </li>
            );
          })}
        </ol>
      </SheetContent>
    </Sheet>
  );
}
