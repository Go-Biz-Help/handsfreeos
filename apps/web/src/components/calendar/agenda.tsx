'use client';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Globe,
  Plus,
  Truck,
  Users,
  Video,
} from 'lucide-react';
import { ZoneChip } from '@/components/settings/my-calendar';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import {
  agendaEmptyWords,
  agendaRows,
  appointmentCount,
  appointmentsOnDay,
  busyFrom,
  BUSY_TITLE,
  dayHeading,
  dayHeadingShort,
  daysWithAppointments,
  NOT_BOOKED_YET,
  NOTHING_BOOKED,
  nowLabel,
  seatsLabel,
  sourceLabel,
  type AgendaAppointment,
  type AgendaInput,
  type AgendaRow,
} from '@hfos/core';
import type { Appointment, TeamSchedule } from '@/lib/api/types';
import {
  fmtDateLong,
  fmtLength,
  fmtMonthYear,
  fmtTime,
  fmtWeekRangeShort,
  minutesBetween,
  weekdayShort,
} from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { areaOf, customersOf, holdOf, holdWords, isPast } from './appt';
import { MonthGrid, type MonthCell } from './month-grid';

/**
 * The views a phone gets. Team and Resources are a column per person or per truck, which wants a screen
 * wider than this one, so the phone offers the three that are about one stretch of time.
 */
export type AgendaView = 'day' | 'week' | 'month';

const VIEWS = [
  { value: 'day', label: 'Day', testId: 'agenda-view-day' },
  { value: 'week', label: 'Week', testId: 'agenda-view-week' },
  { value: 'month', label: 'Month', testId: 'agenda-view-month' },
] as const;

/** The red line where the clock is, between the rows it falls between. */
function NowRow({ at, timeZone }: { at: number; timeZone: string }) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3.5 py-1.5 text-xs font-semibold text-danger-text">
      <span>{nowLabel(at, timeZone)}</span>
      <i className="h-0.5 flex-1 rounded bg-danger" />
    </div>
  );
}

/** Time this person's own Google or Outlook calendar has taken: it blocks bookings and says nothing else. */
function BusyRow({
  at,
  end,
  provider,
  timeZone,
}: {
  at: number;
  end: number;
  provider: 'google' | 'microsoft' | null;
  timeZone: string;
}) {
  return (
    <div className="flex min-h-16 items-stretch gap-3 border-b border-border bg-card px-3.5 py-3">
      <div className="w-[66px] flex-none text-sm font-semibold tabular-nums leading-[1.35]">
        {fmtTime(at, timeZone)}
        <small className="block text-[12.5px] font-normal text-text-3">
          {fmtLength(Math.round((end - at) / 60_000))}
        </small>
      </div>
      <span className="w-1 flex-none rounded bg-[repeating-linear-gradient(180deg,var(--border-strong)_0_3px,transparent_3px_6px)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-text-2">{BUSY_TITLE}</span>
        <span className="text-[13px] text-text-3">{busyFrom(provider)}</span>
      </div>
    </div>
  );
}

function ApptRow({
  appt: a,
  timeZone,
  now,
  onOpen,
}: {
  appt: Appointment;
  timeZone: string;
  now: number | null;
  onOpen: (appt: Appointment) => void;
}) {
  const customers = customersOf(a);
  const area = areaOf(a.location.address);
  const hold = holdOf(a, now);
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
  return (
    <button
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
          <span className="text-[13px] font-medium text-warning-text" data-testid="agenda-held">
            {NOT_BOOKED_YET} · {holdWords(hold, timeZone)}
          </span>
        ) : null}
        {sub ? <span className="truncate text-[13px] text-text-2">{sub}</span> : null}
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
      <ChevronRight className="h-4 w-4 flex-none self-center text-text-3" strokeWidth={1.5} />
    </button>
  );
}

/** Phones: a date strip or a month, Everyone or Just me, and the day — or the whole week — as a list. */
export function Agenda({
  view,
  timeZone,
  date,
  today,
  days,
  monthCells,
  appointments,
  me,
  mine,
  now,
  onView,
  onStep,
  onToday,
  onDate,
  onDay,
  onMine,
  onOpen,
  onNew,
  onWebinar,
}: {
  view: AgendaView;
  timeZone: string;
  date: string;
  today: string;
  /** The week the strip shows and the week list walks; the month has its own cells. */
  days: readonly string[];
  monthCells: readonly MonthCell[];
  appointments: readonly Appointment[];
  me: TeamSchedule | null;
  mine: boolean;
  now: number | null;
  onView: (view: AgendaView) => void;
  /** A week at a time, or a month of them in the month view. */
  onStep: (delta: number) => void;
  onToday: () => void;
  onDate: (date: string) => void;
  /** Open one day on its own, from a month cell or a week heading. */
  onDay: (date: string) => void;
  onMine: (mine: boolean) => void;
  onOpen: (appt: Appointment) => void;
  onNew: () => void;
  /** New webinar, when the business has HandsFreeOS video calls and the person may schedule. */
  onWebinar?: () => void;
}) {
  // The day, its busy rows and the "now" line are core's (`agendaRows`), so the phone app builds the same list from
  // its own copy. The appointments themselves stay the API's, and the row it names is looked up by id.
  const byId = new Map(appointments.map((a) => [a.id, a]));
  const input = (on: string): AgendaInput => ({
    date: on,
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
  });
  const row = (r: AgendaRow) =>
    r.kind === 'now' ? (
      <NowRow key="now" at={r.at} timeZone={timeZone} />
    ) : r.kind === 'busy' ? (
      <BusyRow
        key={`busy-${r.at}`}
        at={r.at}
        end={r.end}
        provider={r.busy.provider}
        timeZone={timeZone}
      />
    ) : (
      <ApptRow
        key={r.appt.id}
        appt={byId.get(r.appt.id)!}
        timeZone={timeZone}
        now={now}
        onOpen={onOpen}
      />
    );

  const byDay = daysWithAppointments(input(date));
  const rows = agendaRows(input(date));
  const booked = appointmentsOnDay(input(date)).length;
  const empty = agendaEmptyWords(mine);
  const stepWord = view === 'month' ? 'month' : 'week';
  const title =
    view === 'week' && days.length
      ? fmtWeekRangeShort(days[0]!, days[days.length - 1]!)
      : fmtMonthYear(date);

  return (
    <div className="flex flex-col" data-testid="agenda">
      <div className="flex flex-none flex-col gap-2 border-b border-border bg-card px-3 pb-3 pt-2.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex min-w-0 items-center gap-0.5">
            <button
              type="button"
              aria-label={`Previous ${stepWord}`}
              onClick={() => onStep(-1)}
              data-testid="agenda-prev"
              className="-ml-2 flex h-8 w-8 flex-none items-center justify-center rounded-control text-text-2"
            >
              <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
            <span className="truncate text-[15px] font-semibold" data-testid="agenda-title">
              {title}
            </span>
            <button
              type="button"
              aria-label={`Next ${stepWord}`}
              onClick={() => onStep(1)}
              data-testid="agenda-next"
              className="flex h-8 w-8 flex-none items-center justify-center rounded-control text-text-2"
            >
              <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.5} />
            </button>
          </div>
          <div className="flex flex-none items-center gap-1.5">
            {onWebinar ? (
              <button
                type="button"
                aria-label="New webinar"
                title="New webinar"
                onClick={onWebinar}
                data-testid="agenda-new-webinar"
                className="flex h-8 w-8 items-center justify-center rounded-control text-text-2"
              >
                <Video className="h-[18px] w-[18px]" strokeWidth={1.5} />
              </button>
            ) : null}
            <ZoneChip timeZone={timeZone} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="h-9 flex-none"
            onClick={onToday}
            data-testid="agenda-today"
          >
            Today
          </Button>
          <Segmented
            fill
            size="lg"
            className="min-w-0 flex-1"
            ariaLabel="View"
            value={view}
            onChange={onView}
            options={VIEWS}
          />
        </div>

        {/* The month is its own strip, and the week list names every day, so only the day view needs one. */}
        {view === 'day' ? (
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
        ) : null}

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

      {view === 'month' ? (
        <MonthGrid
          compact
          cells={monthCells}
          timeZone={timeZone}
          now={now}
          selectedId={null}
          onOpen={onOpen}
          onNew={() => onNew()}
          onDay={onDay}
        />
      ) : view === 'week' ? (
        <div className="border-t border-border" data-testid="agenda-week">
          {days.map((d) => {
            const dayRows = agendaRows(input(d));
            const count = appointmentsOnDay(input(d)).length;
            return (
              <div key={d}>
                <button
                  type="button"
                  onClick={() => onDay(d)}
                  data-testid={`agenda-week-day-${d}`}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 border-b border-border px-4 py-2 text-left',
                    d === today ? 'bg-accent-soft' : 'bg-card-2',
                  )}
                >
                  <span
                    className={cn(
                      'text-[13px] font-semibold',
                      d === today ? 'text-accent-text' : 'text-text-2',
                    )}
                  >
                    {dayHeadingShort(d, today, false)}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-text-3">
                    {appointmentCount(count) || NOTHING_BOOKED}
                    <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </span>
                </button>
                {dayRows.map(row)}
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between px-4 pb-2 pt-3">
            <span className="text-[13px] font-medium">{dayHeading(date, today)}</span>
            <span className="text-xs text-text-3">{appointmentCount(booked)}</span>
          </div>
          <div className="border-t border-border">
            {booked === 0 ? (
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
              rows.map(row)
            )}
          </div>
        </>
      )}
    </div>
  );
}
