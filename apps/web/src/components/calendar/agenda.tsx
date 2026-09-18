'use client';
import { CalendarDays, ChevronRight, Globe, Plus, Truck, Users } from 'lucide-react';
import { ZoneChip } from '@/components/settings/my-calendar';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import {
  agendaEmptyWords,
  agendaRows,
  appointmentCount,
  busyFrom,
  BUSY_TITLE,
  dayHeading,
  daysWithAppointments,
  NOT_BOOKED_YET,
  nowLabel,
  seatsLabel,
  sourceLabel,
  type AgendaAppointment,
  type AgendaInput,
} from '@hfos/core';
import type { Appointment, TeamSchedule } from '@/lib/api/types';
import {
  fmtDateLong,
  fmtLength,
  fmtMonthYear,
  fmtTime,
  minutesBetween,
  weekdayShort,
} from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { areaOf, customersOf, holdOf, holdWords, isPast } from './appt';

/** Phones: a week's date strip, Everyone or Just me, and the chosen day as a list. */
export function Agenda({
  timeZone,
  date,
  today,
  days,
  appointments,
  me,
  mine,
  now,
  onDate,
  onMine,
  onOpen,
  onNew,
}: {
  timeZone: string;
  date: string;
  today: string;
  days: readonly string[];
  appointments: readonly Appointment[];
  me: TeamSchedule | null;
  mine: boolean;
  now: number | null;
  onDate: (date: string) => void;
  onMine: (mine: boolean) => void;
  onOpen: (appt: Appointment) => void;
  onNew: () => void;
}) {
  // The day, its busy rows and the "now" line are core's (`agendaRows`), so the phone app builds the same list from
  // its own copy. The appointments themselves stay the API's, and the row it names is looked up by id.
  const byId = new Map(appointments.map((a) => [a.id, a]));
  const input: AgendaInput = {
    date,
    today,
    timeZone,
    mine,
    myUserId: me?.userId ?? null,
    now,
    appointments: appointments.map(
      (a) =>
        ({
          id: a.id,
          startsAt: a.startsAt,
          staff: a.staff,
        }) as unknown as AgendaAppointment,
    ),
    busy: (me?.busy ?? []).map((b) => ({
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      provider: me?.connection?.provider ?? null,
    })),
  };
  const byDay = daysWithAppointments(input);
  const rows = agendaRows(input);
  const onDay = rows.filter((r) => r.kind === 'appt');
  const empty = agendaEmptyWords(mine);

  return (
    <div className="flex flex-col" data-testid="agenda">
      <div className="flex flex-none flex-col gap-2 border-b border-border bg-card px-3 pb-3 pt-2.5">
        <div className="flex items-center justify-between px-1">
          <span className="text-[15px] font-semibold">{fmtMonthYear(date)}</span>
          <ZoneChip timeZone={timeZone} />
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d) => {
            const on = d === date;
            return (
              <button
                key={d}
                type="button"
                onClick={() => onDate(d)}
                aria-pressed={on}
                aria-label={fmtDateLong(d)}
                data-testid={`agenda-day-${d}`}
                className={cn(
                  'flex min-h-[58px] flex-col items-center gap-[3px] rounded-menu pb-1.5 pt-[7px]',
                  on ? 'bg-accent text-white' : 'text-text',
                )}
              >
                <span
                  className={cn('text-[11px] font-medium', on ? 'text-white/85' : 'text-text-3')}
                >
                  {weekdayShort(d)}
                </span>
                <span
                  className={cn(
                    'text-base font-semibold leading-[1.1]',
                    !on && d === today && 'text-accent-text',
                  )}
                >
                  {Number(d.slice(8))}
                </span>
                <span
                  className={cn(
                    'h-[5px] w-[5px] rounded-full',
                    byDay.has(d) ? (on ? 'bg-white' : 'bg-accent') : 'bg-transparent',
                  )}
                />
              </button>
            );
          })}
        </div>
        <Segmented
          fill
          size="lg"
          value={mine ? 'mine' : 'all'}
          onChange={(v) => onMine(v === 'mine')}
          options={[
            { value: 'all', label: 'Everyone' },
            { value: 'mine', label: 'Just me' },
          ]}
        />
      </div>
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="text-[13px] font-medium">{dayHeading(date, today)}</span>
        <span className="text-xs text-text-3">{appointmentCount(onDay.length)}</span>
      </div>
      <div className="border-t border-border">
        {onDay.length === 0 ? (
          <div className="border-b border-border bg-card px-6 py-11 text-center text-text-2">
            <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-card-2 text-text-3">
              <CalendarDays className="h-5 w-5" strokeWidth={1.5} />
            </span>
            <div className="text-[15px] font-semibold text-text">{empty.title}</div>
            <div className="mt-1 text-[13px]">{empty.body}</div>
            <Button variant="secondary" className="mt-3.5 h-11" onClick={onNew}>
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              {empty.action}
            </Button>
          </div>
        ) : (
          rows.map((r) => {
            if (r.kind === 'now')
              return (
                <div
                  key="now"
                  className="flex items-center gap-2 border-b border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-danger-text"
                >
                  <span>{nowLabel(r.at, timeZone)}</span>
                  <i className="h-0.5 flex-1 rounded bg-danger" />
                </div>
              );
            if (r.kind === 'busy')
              return (
                <div
                  key={`busy-${r.at}`}
                  className="flex min-h-16 items-stretch gap-3 border-b border-border bg-card px-3.5 py-3"
                >
                  <div className="w-[66px] flex-none text-sm font-semibold tabular-nums leading-[1.35]">
                    {fmtTime(r.at, timeZone)}
                    <small className="block text-[12.5px] font-normal text-text-3">
                      {fmtLength(Math.round((r.end - r.at) / 60_000))}
                    </small>
                  </div>
                  <span className="w-1 flex-none rounded bg-[repeating-linear-gradient(180deg,var(--border-strong)_0_3px,transparent_3px_6px)]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[15px] font-semibold text-text-2">{BUSY_TITLE}</span>
                    <span className="text-[13px] text-text-3">{busyFrom(r.busy.provider)}</span>
                  </div>
                </div>
              );
            const a = byId.get(r.appt.id)!;
            const customers = customersOf(a);
            const area = areaOf(a.location.address);
            const hold = holdOf(a, now);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onOpen(a)}
                data-testid={`agenda-appt-${a.id}`}
                data-held={hold ? 'true' : undefined}
                className="flex min-h-16 w-full items-stretch gap-3 border-b border-border bg-card px-3.5 py-3 text-left hover:bg-card-2"
                style={{ ['--c' as string]: a.calendar.color }}
              >
                <div className="w-[66px] flex-none text-sm font-semibold tabular-nums leading-[1.35]">
                  {fmtTime(a.startsAt, timeZone)}
                  <small className="block text-[12.5px] font-normal text-text-3">
                    {fmtLength(minutesBetween(a.startsAt, a.endsAt))}
                  </small>
                </div>
                <span
                  className={cn(
                    'w-1 flex-none rounded',
                    hold
                      ? 'bg-[repeating-linear-gradient(180deg,var(--warning-text)_0_3px,transparent_3px_6px)]'
                      : 'bg-[var(--c)]',
                  )}
                />
                <div
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-0.5',
                    (isPast(a, now) || a.status !== 'scheduled') && 'opacity-60',
                  )}
                >
                  <span className="truncate text-[15px] font-semibold">{a.title}</span>
                  {/* Before anything else on the row: nobody should ring to confirm a visit that isn't booked. */}
                  {hold ? (
                    <span
                      className="text-[13px] font-medium text-warning-text"
                      data-testid="agenda-held"
                    >
                      {NOT_BOOKED_YET} · {holdWords(hold, timeZone)}
                    </span>
                  ) : null}
                  {(() => {
                    const sub =
                      [
                        customers.length === 1
                          ? customers[0]!.fullName
                          : customers.length
                            ? `${customers.length} customers`
                            : null,
                        area,
                      ]
                        .filter(Boolean)
                        .join(' · ') || (a.calendar.name !== a.title ? a.calendar.name : '');
                    return sub ? (
                      <span className="truncate text-[13px] text-text-2">{sub}</span>
                    ) : null;
                  })()}
                  <span className="mt-[5px] flex items-center gap-1.5">
                    {a.staff.length ? (
                      <span className="flex pr-1">
                        {a.staff.map((s) => (
                          <Avatar
                            key={s.userId}
                            name={s.fullName}
                            seed={s.userId}
                            size="sm"
                            className="-mr-1 ring-2 ring-card"
                          />
                        ))}
                      </span>
                    ) : null}
                    {a.resources.map((x) => (
                      <span key={x.resourceId} className="cal-mini">
                        <Truck className="h-3 w-3" strokeWidth={1.5} />
                        {x.name}
                      </span>
                    ))}
                    {a.capacity > 1 ? (
                      <span className="cal-mini">
                        <Users className="h-3 w-3" strokeWidth={1.5} />
                        {seatsLabel(a.seatsTaken, a.capacity)}
                      </span>
                    ) : null}
                    {a.source === 'booking_page' || a.source === 'ai_teammate' ? (
                      <span className="cal-mini">
                        <Globe className="h-3 w-3" strokeWidth={1.5} />
                        {sourceLabel(a.source)}
                      </span>
                    ) : null}
                  </span>
                </div>
                <ChevronRight
                  className="h-4 w-4 flex-none self-center text-text-3"
                  strokeWidth={1.5}
                />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
