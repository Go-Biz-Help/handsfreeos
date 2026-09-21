'use client';
import { ChevronRight, Copy, Plus } from 'lucide-react';
import Link from 'next/link';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { copyText } from '@/components/ui/copy-field';
import { EmptyState } from '@/components/ui/empty-state';
import type { CalendarList, CalendarSummary } from '@/lib/api/types';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { usePublicOrigin } from '@/lib/use-origin';
import { CalendarDot, CalendarStatusBadge, LabelChips } from './chips';

export function calendarLink(c: Pick<CalendarSummary, 'bookingPath' | 'permanentPath'>) {
  return c.bookingPath ?? c.permanentPath;
}

/** Settings → Calendars: each calendar with its inferred labels, link, status and the next 7 days. */
export function CalendarsList({
  workspaceId,
  items,
  site,
  brandedOrigin,
}: {
  workspaceId: string;
  items: CalendarSummary[];
  site: CalendarList['site'];
  /** Their own domain when one is serving (M17). */
  brandedOrigin: string | null;
}) {
  useLiveRefresh(['calendar', 'booking_site', 'appointment']);
  const origin = usePublicOrigin(brandedOrigin);
  const base = `/app/w/${workspaceId}/settings/calendars`;
  const shown = [...items].sort(
    (a, b) => Number(a.status === 'archived') - Number(b.status === 'archived'),
  );

  return (
    <Card className="overflow-hidden" data-testid="calendars-list">
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3.5 pt-4 md:px-6">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Calendars</h2>
          <p className="mt-1 text-[13px] text-text-2">
            Every calendar is the same kind of thing. Its settings decide how it books, and they can
            change any time without changing its link.
          </p>
        </div>
        <ButtonLink href={`${base}/new`} variant="primary" size="sm" data-testid="calendar-new">
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          New calendar
        </ButtonLink>
      </div>
      {!site ? (
        <div className="mx-5 mb-3.5 rounded-menu bg-accent-soft px-3.5 py-2.5 text-[13px] text-accent-text md:mx-6">
          Set up your booking site to give each calendar a named public link.{' '}
          <Link href={`${base}/booking-site`} className="font-medium underline">
            Set up the booking site
          </Link>
        </div>
      ) : !site.enabled ? (
        <div className="mx-5 mb-3.5 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text md:mx-6">
          Online booking is off, so the links say it isn’t taking bookings.{' '}
          <Link href={`${base}/booking-site`} className="font-medium underline">
            Booking site
          </Link>
        </div>
      ) : null}
      {shown.length === 0 ? (
        <EmptyState
          title="No calendars yet"
          className="border-t border-border"
          actions={
            <ButtonLink href={`${base}/new`} variant="primary" size="sm">
              New calendar
            </ButtonLink>
          }
        >
          Start with a preset like Personal or Round Robin. You can change how it works later.
        </EmptyState>
      ) : (
        <ul>
          {shown.map((c) => {
            const link = calendarLink(c);
            return (
              <li
                key={c.id}
                className="relative flex items-center gap-3 border-t border-border px-5 py-3 hover:bg-card-2 md:px-6"
                data-testid={`calendar-row-${c.id}`}
              >
                <CalendarDot color={c.color} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Link
                      href={`${base}/${c.id}`}
                      className="font-medium after:absolute after:inset-0 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <LabelChips tags={c.labels.tags} />
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-text-3">
                    <span className="truncate font-mono text-[11.5px]">
                      {origin.replace(/^https?:\/\//, '')}
                      {link}
                    </span>
                    <button
                      type="button"
                      aria-label={`Copy the link to ${c.name}`}
                      className="relative z-10 rounded p-0.5 text-text-3 hover:text-text"
                      onClick={() => void copyText(`${origin}${link}`, 'Link copied')}
                    >
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </button>
                  </span>
                </span>
                <span className="hidden text-[13px] text-text-2 sm:inline">
                  {c.upcomingCount} in the next 7 days
                </span>
                <CalendarStatusBadge status={c.status} />
                <ChevronRight className="h-4 w-4 flex-none text-text-3" strokeWidth={1.5} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
