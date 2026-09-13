'use client';
import { CalendarDays, ChevronRight, Globe, Plus, Truck, Users } from 'lucide-react';
import { ZoneChip } from '@/components/settings/my-calendar';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import type { Appointment, TeamSchedule } from '@/lib/api/types';
import {
  dateOf,
  fmtDateLong,
  fmtLength,
  fmtMonthYear,
  fmtTime,
  minutesBetween,
  weekdayShort,
} from '@/lib/calendar/time';
import { cn } from '@/lib/utils';
import { calendarProviderName } from '@/components/settings/calendar-connection-card';
import { areaOf, customersOf, isPast } from './appt';

type Row =
  | { kind: 'appt'; at: number; appt: Appointment }
  | { kind: 'busy'; at: number; end: number; provider: 'google' | 'microsoft' | null }
  | { kind: 'now'; at: number };

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
  const shown = appointments.filter((a) => !mine || a.staff.some((s) => s.userId === me?.userId));
  const byDay = new Set(shown.map((a) => dateOf(a.startsAt, timeZone)));
  const onDay = shown
    .filter((a) => dateOf(a.startsAt, timeZone) === date)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const rows: Row[] = onDay.map((a) => ({ kind: 'appt', at: Date.parse(a.startsAt), appt: a }));
  if (mine && me)
    for (const b of me.busy)
      if (dateOf(b.startsAt, timeZone) === date)
        rows.push({
          kind: 'busy',
          at: Date.parse(b.startsAt),
          end: Date.parse(b.endsAt),
          provider: me.connection?.provider ?? null,
        });
  rows.sort((a, b) => a.at - b.at);
  if (now !== null && date === today && onDay.length) {
    const i = rows.findIndex((r) => r.at > now);
    rows.splice(i === -1 ? rows.length : i, 0, { kind: 'now', at: now });
  }

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
        <span className="text-[13px] font-medium">
          {date === today ? 'Today · ' : ''}
          {fmtDateLong(date)}
        </span>
        <span className="text-xs text-text-3">
          {onDay.length
            ? `${onDay.length} ${onDay.length === 1 ? 'appointment' : 'appointments'}`
            : ''}
        </span>
      </div>
      <div className="border-t border-border">
        {onDay.length === 0 ? (
          <div className="border-b border-border bg-card px-6 py-11 text-center text-text-2">
            <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-card-2 text-text-3">
              <CalendarDays className="h-5 w-5" strokeWidth={1.5} />
            </span>
            <div className="text-[15px] font-semibold text-text">
              {mine ? 'Nothing booked for you' : 'Nothing booked'}
            </div>
            <div className="mt-1 text-[13px]">Open times can still be booked online.</div>
            <Button variant="secondary" className="mt-3.5 h-11" onClick={onNew}>
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New appointment
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
                  <span>Now · {fmtTime(r.at, timeZone)}</span>
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
                    <span className="text-[15px] font-semibold text-text-2">Busy</span>
                    <span className="text-[13px] text-text-3">
                      From {r.provider ? calendarProviderName(r.provider) : 'your calendar'}
                    </span>
                  </div>
                </div>
              );
            const a = r.appt;
            const customers = customersOf(a);
            const area = areaOf(a.location.address);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onOpen(a)}
                data-testid={`agenda-appt-${a.id}`}
                className="flex min-h-16 w-full items-stretch gap-3 border-b border-border bg-card px-3.5 py-3 text-left hover:bg-card-2"
                style={{ ['--c' as string]: a.calendar.color }}
              >
                <div className="w-[66px] flex-none text-sm font-semibold tabular-nums leading-[1.35]">
                  {fmtTime(a.startsAt, timeZone)}
                  <small className="block text-[12.5px] font-normal text-text-3">
                    {fmtLength(minutesBetween(a.startsAt, a.endsAt))}
                  </small>
                </div>
                <span className="w-1 flex-none rounded bg-[var(--c)]" />
                <div
                  className={cn(
                    'flex min-w-0 flex-1 flex-col gap-0.5',
                    (isPast(a, now) || a.status !== 'scheduled') && 'opacity-60',
                  )}
                >
                  <span className="truncate text-[15px] font-semibold">{a.title}</span>
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
                    {a.resources.map((x) => (
                      <span key={x.resourceId} className="cal-mini">
                        <Truck className="h-3 w-3" strokeWidth={1.5} />
                        {x.name}
                      </span>
                    ))}
                    {a.capacity > 1 ? (
                      <span className="cal-mini">
                        <Users className="h-3 w-3" strokeWidth={1.5} />
                        {a.seatsTaken}/{a.capacity} seats
                      </span>
                    ) : null}
                    {a.source === 'booking_page' ? (
                      <span className="cal-mini">
                        <Globe className="h-3 w-3" strokeWidth={1.5} />
                        Booked online
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
