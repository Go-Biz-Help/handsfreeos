'use client';
import { CalendarPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Appointment } from '@/lib/api/types';
import {
  NOT_BOOKED_YET,
  sourceLabel,
  upcomingDetail,
  UPCOMING_EMPTY,
  UPCOMING_TITLE,
  type AgendaAppointment,
} from '@hfos/core';
import { dateOf, fmtMonthDay, todayIn, weekdayShort } from '@/lib/calendar/time';
import { holdOf, holdWords, useNow } from './appt';

/** One appointment as a row: a date tile, the calendar's color, what and when, who and what's reserved. */
export function AppointmentRow({
  appt: a,
  timeZone,
  onOpen,
}: {
  appt: Appointment;
  timeZone: string;
  onOpen: (id: string) => void;
}) {
  const now = useNow();
  const d = dateOf(a.startsAt, timeZone);
  const sameMonth = d.slice(0, 7) === todayIn(timeZone).slice(0, 7);
  const hold = holdOf(a, now);
  // The same line core gives the phone's Upcoming card.
  const detail = upcomingDetail(a as unknown as AgendaAppointment, timeZone);
  return (
    <button
      type="button"
      onClick={() => onOpen(a.id)}
      className="flex w-full items-center gap-3 border-t border-border py-[9px] text-left hover:bg-card-2"
      data-testid={`upcoming-${a.id}`}
      data-held={hold ? 'true' : undefined}
    >
      <span className="flex w-11 flex-none flex-col items-center rounded-control bg-card-2 py-1">
        <span className="text-[10.5px] font-semibold uppercase text-text-3">{weekdayShort(d)}</span>
        <span className="text-[13px] font-medium leading-tight">
          {sameMonth ? Number(d.slice(8)) : fmtMonthDay(d)}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 flex-none rounded-full"
            style={{ background: a.calendar.color }}
            aria-hidden
          />
          <span className="truncate text-[13px] font-medium">{a.title}</span>
          {a.source === 'booking_page' || a.source === 'ai_teammate' ? (
            <Badge variant="gray" className="h-5 text-[11.5px]">
              {sourceLabel(a.source)}
            </Badge>
          ) : null}
          {hold ? (
            <Badge variant="pending" className="h-5 text-[11.5px]">
              {NOT_BOOKED_YET}
            </Badge>
          ) : a.status === 'completed' ? (
            <Badge variant="ok" className="h-5 text-[11.5px]">
              Completed
            </Badge>
          ) : a.status === 'no_show' ? (
            <Badge variant="gray" className="h-5 text-[11.5px]">
              No-show
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-xs text-text-3">
          {hold ? holdWords(hold, timeZone) : detail}
        </span>
      </span>
    </button>
  );
}

/** "Upcoming appointments" on a customer or lead page, with Book. */
export function UpcomingAppointments({
  timeZone,
  items,
  onBook,
  onOpen,
}: {
  timeZone: string;
  items: readonly Appointment[];
  onBook?: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <Card className="px-4 pb-2 pt-4 md:px-[18px]" data-testid="upcoming-appointments">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold">{UPCOMING_TITLE}</h3>
        {onBook ? (
          <Button variant="ghost" size="sm" onClick={onBook}>
            <CalendarPlus className="h-4 w-4" strokeWidth={1.5} />
            Book
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="border-t border-border py-3 text-[13px] text-text-2">{UPCOMING_EMPTY}</p>
      ) : (
        items.map((a) => <AppointmentRow key={a.id} appt={a} timeZone={timeZone} onOpen={onOpen} />)
      )}
    </Card>
  );
}
