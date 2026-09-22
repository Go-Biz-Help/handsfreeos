'use client';
import {
  addDays,
  hasWorkspacePermission,
  instantAt,
  minutesToClock,
  parseClock,
  placeOnDay,
  visibleHours,
  weekdayOf,
  weekOf,
  type MinuteSpan,
  type WeeklyHours,
} from '@hfos/core';
import {
  AlertTriangle,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Settings2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { startTransition, useMemo, useOptimistic, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ResourceIcon, RESOURCE_KINDS } from '@/components/calendars/resources-page';
import {
  calendarProviderName,
  connectCalendar,
  ProviderMark,
} from '@/components/settings/calendar-connection-card';
import { ZoneChip } from '@/components/settings/my-calendar';
import { Avatar } from '@/components/ui/avatar';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Segmented } from '@/components/ui/segmented';
import { errorMessage } from '@/lib/api/client';
import type {
  Appointment,
  CalendarSummary,
  ResourceItem,
  Role,
  TeamSchedule,
} from '@/lib/api/types';
import {
  clockLabel,
  dateOf,
  fmtDateLong,
  fmtMonthYear,
  fmtWeekRange,
  hourLabel,
  weekdayShort,
} from '@/lib/calendar/time';
import {
  calendarHref,
  CLOSED_NEW,
  parseCalendarQuery,
  type CalendarQuery,
} from '@/lib/calendar/url';
import { useLiveRefresh } from '@/lib/realtime/live-provider';
import { useMatches } from '@/lib/use-media';
import { cn, relativeTime } from '@/lib/utils';
import { Agenda } from './agenda';
import { AppointmentDialog, type BookedResult } from './appointment-dialog';
import { AppointmentSheet } from './appointment-sheet';
import { firstName, useNow } from './appt';
import { MonthGrid, type MonthBlock, type MonthCell } from './month-grid';
import { MoveDialog } from './move-dialog';
import { TimeGrid, type GridBlock, type GridColumn, type GridMove } from './time-grid';

const VIEWS = [
  { value: 'day', label: 'Day', testId: 'view-day' },
  { value: 'week', label: 'Week', testId: 'view-week' },
  { value: 'month', label: 'Month', testId: 'view-month' },
  { value: 'team', label: 'Team', testId: 'view-team' },
  { value: 'resources', label: 'Resources', testId: 'view-resources' },
] as const;

/** "8 AM–6 PM" from a day's weekly hours, or "Off". */
function dayHours(weekly: WeeklyHours, date: string): string {
  const day = weekly
    .filter((h) => h.day === weekdayOf(date))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!day.length) return 'Off';
  const label = (clock: string) => {
    const m = parseClock(clock);
    return m % 60 ? clockLabel(m) : hourLabel(m / 60);
  };
  return `${label(day[0]!.start)}–${label(day[day.length - 1]!.end)}`;
}

const FilterLabel = ({ children }: { children: ReactNode }) => (
  <span className="whitespace-nowrap text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
    {children}
  </span>
);

/**
 * /calendar. Wide screens: Team day, Week, Day and Resources on the in-house time grid, with calendar and
 * people filters, drag to move (desktop pointers) and New appointment. Phones: the agenda. Opening an
 * appointment or New appointment only changes the address (no reload); moving past the loaded week does.
 */
export function CalendarPage(props: {
  workspaceId: string;
  myUserId: string;
  role: Role;
  timeZone: string;
  today: string;
  query: CalendarQuery;
  days: string[];
  calendars: CalendarSummary[];
  resources: ResourceItem[];
  people: TeamSchedule[];
  appointments: Appointment[];
}) {
  const { workspaceId, myUserId, timeZone: tz, today, days, calendars, resources, people } = props;
  const router = useRouter();
  const search = useSearchParams();
  const urlQuery = useMemo(
    () => (search ? parseCalendarQuery(Object.fromEntries(search.entries()), today) : props.query),
    [search, today, props.query],
  );
  // The address is the state. Every change navigates (router.replace in a transition), and useOptimistic
  // shows it at once while the server renders the page for the new address. Never history.replaceState:
  // after one, Next can keep a stale page for an address it had already loaded.
  const [q, patchQuery] = useOptimistic(
    urlQuery,
    (current: CalendarQuery, patch: Partial<CalendarQuery>) => ({ ...current, ...patch }),
  );
  useLiveRefresh(['appointment', 'calendar', 'schedule', 'calendar_connection', 'resource']);
  const now = useNow();
  const fine = useMatches('(pointer: fine)');
  const canManage = hasWorkspacePermission(props.role, 'calendars.manage');
  const [move, setMove] = useState<GridMove | null>(null);

  const href = (patch: Partial<CalendarQuery>) =>
    calendarHref(workspaceId, { ...q, ...patch }, today);
  const go = (patch: Partial<CalendarQuery>) => {
    const next = href(patch);
    startTransition(() => {
      patchQuery(patch);
      router.replace(next, { scroll: false });
    });
  };

  const liveCalendars = calendars.filter((c) => c.status !== 'archived');
  const shownCalendars = q.calendars ? new Set(q.calendars) : null;
  const visible = props.appointments.filter(
    (a) => !shownCalendars || shownCalendars.has(a.calendar.id),
  );
  const me = people.find((p) => p.userId === myUserId) ?? null;
  const picked = q.people ? people.filter((p) => q.people!.includes(p.userId)) : [];
  const team = picked.length ? picked : people;
  const focus =
    (q.people && people.find((p) => p.userId === q.people![0])) || me || people[0] || null;
  const date = days.includes(q.date) ? q.date : props.query.date;

  function personColumn(p: TeamSchedule, day: string, key: string, header: ReactNode): GridColumn {
    const place = (s: string, e: string) => placeOnDay(Date.parse(s), Date.parse(e), day, tz);
    const open = [...p.hours, ...p.timeOff.filter((t) => t.kind === 'available')]
      .map((h) => place(h.startsAt, h.endsAt))
      .filter((s): s is MinuteSpan => !!s);
    const blocks: GridBlock[] = [];
    p.busy.forEach((b, i) => {
      const span = place(b.startsAt, b.endsAt);
      if (span)
        blocks.push({
          key: `busy-${i}`,
          span,
          kind: 'busy',
          title: `Busy in ${p.connection ? calendarProviderName(p.connection.provider) : 'their calendar'}`,
          provider: p.connection?.provider ?? null,
        });
    });
    for (const t of p.timeOff) {
      if (t.kind !== 'unavailable') continue;
      const span = place(t.startsAt, t.endsAt);
      if (span) blocks.push({ key: t.id, span, kind: 'time_off', title: t.note || 'Time off' });
    }
    const events = visible.filter(
      (a) => a.staff.some((s) => s.userId === p.userId) && place(a.startsAt, a.endsAt),
    );
    return { key, date: day, header, today: day === today, open, blocks, events, userId: p.userId };
  }

  function personHead(p: TeamSchedule, day: string, count: number) {
    const c = p.connection;
    return (
      <>
        <Avatar name={p.fullName} seed={p.userId} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium">{p.fullName}</span>
          <span className="truncate text-xs text-text-3">
            {dayHours(p.weekly, day)} · {count} {day === today ? 'today' : 'booked'}
          </span>
        </span>
        {c && c.status === 'active' ? (
          <span title={`${calendarProviderName(c.provider)} connected`} className="flex-none">
            <ProviderMark provider={c.provider} className="h-4 w-4" />
          </span>
        ) : c && (c.status === 'reauth_required' || c.status === 'error') ? (
          <span
            title={`${calendarProviderName(c.provider)} needs reconnecting`}
            className="flex-none text-warning-text"
          >
            <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
          </span>
        ) : (
          <span
            className="hidden flex-none text-xs text-text-3 2xl:inline"
            title="No calendar connected"
          >
            No calendar linked
          </span>
        )}
      </>
    );
  }

  /** A resource's open hours that day, or null when it can be booked any time. */
  function resourceOpen(r: ResourceItem): MinuteSpan[] | null {
    const weekly = r.hours as WeeklyHours | null;
    return weekly
      ? weekly
          .filter((h) => h.day === weekdayOf(date))
          .map((h) => ({ top: parseClock(h.start), bottom: parseClock(h.end) }))
      : null;
  }

  /**
   * Team day: appointments that need no staff get a column per resource they reserve (the first one, so
   * each shows once), only on days that have any. Overlaps sit side by side in it.
   */
  function stafflessColumns(): GridColumn[] {
    const groups = new Map<string, Appointment[]>();
    for (const a of visible) {
      if (a.staff.length || !placeOnDay(Date.parse(a.startsAt), Date.parse(a.endsAt), date, tz))
        continue;
      const key = a.resources[0]?.resourceId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    return [...groups].map(([resourceId, events]) => {
      const r = resources.find((x) => x.id === resourceId) ?? null;
      const name = r?.name ?? events[0]!.resources[0]?.name ?? 'No staff needed';
      const count = events.filter((a) => dateOf(a.startsAt, tz) === date).length;
      return {
        key: `staffless-${resourceId || 'none'}`,
        date,
        today: date === today,
        open: r ? resourceOpen(r) : null,
        blocks: [],
        events,
        userId: null,
        header: (
          <>
            <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-card-2 text-text-2">
              {r ? (
                <ResourceIcon kind={r.kind} />
              ) : (
                <CalendarDays className="h-4 w-4" strokeWidth={1.5} />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium">{name}</span>
              <span className="truncate text-xs text-text-3">
                No staff · {count} {date === today ? 'today' : 'booked'}
              </span>
            </span>
          </>
        ),
      };
    });
  }

  function resourceColumn(r: ResourceItem): GridColumn {
    const open = resourceOpen(r);
    const events = visible.filter(
      (a) =>
        a.resources.some((x) => x.resourceId === r.id) &&
        placeOnDay(Date.parse(a.startsAt), Date.parse(a.endsAt), date, tz),
    );
    return {
      key: r.id,
      date,
      today: date === today,
      open,
      blocks: [],
      events,
      userId: null,
      header: (
        <>
          <span className="inline-flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-card-2 text-text-2">
            <ResourceIcon kind={r.kind} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium">{r.name}</span>
            <span className="truncate text-xs text-text-3">
              {RESOURCE_KINDS[r.kind].label} · {r.quantity}
            </span>
          </span>
        </>
      ),
    };
  }

  let columns: GridColumn[];
  if (q.view === 'week' && focus)
    columns = days.map((d) => {
      const count = visible.filter(
        (a) => a.staff.some((s) => s.userId === focus.userId) && dateOf(a.startsAt, tz) === d,
      ).length;
      const off = dayHours(focus.weekly, d) === 'Off';
      return personColumn(
        focus,
        d,
        d,
        <span className="flex items-center gap-2" data-count={count}>
          <span className="text-xs font-medium uppercase tracking-[0.04em] text-text-3">
            {weekdayShort(d)}
          </span>
          <span
            className={cn(
              'inline-flex items-center justify-center text-[15px] font-semibold',
              d === today && 'h-[26px] w-[26px] rounded-full bg-accent text-[13.5px] text-white',
            )}
          >
            {Number(d.slice(8))}
          </span>
          {off ? <span className="text-xs text-text-3">Off</span> : null}
        </span>,
      );
    });
  else if (q.view === 'day' && focus) {
    const count = visible.filter(
      (a) => a.staff.some((s) => s.userId === focus.userId) && dateOf(a.startsAt, tz) === date,
    ).length;
    columns = [personColumn(focus, date, focus.userId, personHead(focus, date, count))];
  } else if (q.view === 'resources') columns = resources.map(resourceColumn);
  else
    columns = [
      ...team.map((p) => {
        const count = visible.filter(
          (a) => a.staff.some((s) => s.userId === p.userId) && dateOf(a.startsAt, tz) === date,
        ).length;
        return personColumn(p, date, p.userId, personHead(p, date, count));
      }),
      ...stafflessColumns(),
    ];

  const hours = visibleHours(
    columns.flatMap((c) => [
      ...(c.open ?? []),
      // Busy times and time off stretch the day too. Without them the grid keeps its 7–18 window and
      // the time grid drops any block outside it, so an evening dentist appointment read from someone's
      // Google or Outlook calendar would block bookings while showing nowhere.
      ...c.blocks.map((b) => b.span),
      ...c.events
        .map((a) => placeOnDay(Date.parse(a.startsAt), Date.parse(a.endsAt), c.date, tz))
        .filter((s): s is MinuteSpan => !!s),
    ]),
    { from: 7, to: 18 },
  );

  const openNew = (prefill: Partial<CalendarQuery> = {}) =>
    go({ ...CLOSED_NEW, new: true, ...prefill });
  function booked(out: BookedResult) {
    go({ ...CLOSED_NEW, date: dateOf(out.startsAt, tz) });
  }

  const toggleCalendar = (id: string) => {
    const all = liveCalendars.map((c) => c.id);
    const on = q.calendars ?? all;
    const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    if (!next.length) return toast('Keep at least one calendar showing.');
    go({ calendars: next.length === all.length ? null : next });
  };
  const togglePerson = (id: string) => {
    const on = q.people ?? people.map((p) => p.userId);
    const next = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
    if (!next.length) return toast('Keep at least one person showing.');
    go({ people: next.length === people.length ? null : next });
  };

  const step = q.view === 'week' ? 7 : 1;
  /** Month steps a month at a time, so February's length never drags the date into the wrong one. */
  const monthStep = (delta: number) => {
    const [y, m] = date.split('-').map(Number);
    const t = y! * 12 + (m! - 1) + delta;
    return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}-01`;
  };
  const stepTo = (delta: number) =>
    q.view === 'month' ? monthStep(delta) : addDays(date, delta * step);
  const stepWord = q.view === 'month' ? 'month' : q.view === 'week' ? 'week' : 'day';
  const title =
    q.view === 'month'
      ? fmtMonthYear(date)
      : q.view === 'week'
        ? fmtWeekRange(days[0]!, days[6]!)
        : fmtDateLong(date);
  /*
   * Month is one person's month, the way Week and Day are one person's, so the Person filter means the
   * same thing in all three and a busy time read from Google has somebody it belongs to. A cell lists
   * what is on that day in order; it is not drawn to scale, so nothing is dropped for falling outside
   * an hour range.
   */
  const monthCells: MonthCell[] =
    q.view === 'month' && focus
      ? days.map((d) => {
          const place = (a: string, b: string) => placeOnDay(Date.parse(a), Date.parse(b), d, tz);
          const blocks: MonthBlock[] = [];
          focus.busy.forEach((b, i) => {
            const span = place(b.startsAt, b.endsAt);
            if (span)
              blocks.push({
                key: `busy-${d}-${i}`,
                span,
                kind: 'busy',
                title: `Busy in ${focus.connection ? calendarProviderName(focus.connection.provider) : 'their calendar'}`,
                provider: focus.connection?.provider ?? null,
              });
          });
          for (const t of focus.timeOff) {
            if (t.kind !== 'unavailable') continue;
            const span = place(t.startsAt, t.endsAt);
            if (span)
              blocks.push({
                key: `off-${d}-${t.id}`,
                span,
                kind: 'time_off',
                title: t.note || 'Time off',
              });
          }
          return {
            date: d,
            today: d === today,
            inMonth: d.slice(0, 7) === date.slice(0, 7),
            events: visible
              .filter(
                (a) =>
                  a.staff.some((x) => x.userId === focus.userId) && place(a.startsAt, a.endsAt),
              )
              .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
            blocks,
          };
        })
      : [];
  const reconnect = (q.view === 'team' ? team : focus ? [focus] : []).filter(
    (p) => p.connection?.status === 'reauth_required',
  );
  const moveTarget = move && {
    kind: 'drop' as const,
    start: instantAt(move.to.date, move.top, tz),
    end: instantAt(move.to.date, move.bottom, tz),
    userIds:
      q.view === 'team' && move.to.userId && move.from.userId && move.to.userId !== move.from.userId
        ? [
            ...new Set(
              move.appt.staff.map((s) =>
                s.userId === move.from.userId ? move.to.userId! : s.userId,
              ),
            ),
          ]
        : null,
  };
  const simplePeople = people.map((p) => ({ userId: p.userId, fullName: p.fullName }));

  return (
    <>
      <div
        className="hidden min-h-0 flex-1 flex-col gap-3 md:flex"
        data-testid="calendar-page"
        data-view={q.view}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold leading-tight tracking-[-0.01em]">Calendar</h1>
          <div className="flex gap-2">
            {canManage ? (
              <ButtonLink href={`/app/w/${workspaceId}/settings/calendars`} variant="secondary">
                <Settings2 className="h-4 w-4" strokeWidth={1.5} />
                Manage calendars
              </ButtonLink>
            ) : null}
            <Button onClick={() => openNew({ date })} data-testid="calendar-new">
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New appointment
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <Button variant="secondary" size="sm" onClick={() => go({ date: today })}>
              Today
            </Button>
            <span className="flex">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Previous ${stepWord}`}
                title={`Previous ${stepWord}`}
                onClick={() => go({ date: stepTo(-1) })}
              >
                <ChevronLeft className="h-[18px] w-[18px]" strokeWidth={1.5} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Next ${stepWord}`}
                title={`Next ${stepWord}`}
                onClick={() => go({ date: stepTo(1) })}
              >
                <ChevronRight className="h-[18px] w-[18px]" strokeWidth={1.5} />
              </Button>
            </span>
            <h2 className="text-lg font-semibold tracking-tight" data-testid="calendar-title">
              {title}
            </h2>
            <ZoneChip timeZone={tz} />
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <span className="hidden items-center gap-1.5 text-xs text-text-3 xl:flex">
              <span className="cal-legend-busy h-3 w-[18px] rounded-[3px] border border-border" />
              Busy in Google or Outlook
            </span>
            <span className="hidden items-center gap-1.5 text-xs text-text-3 xl:flex">
              <span className="cal-legend-travel h-3 w-[18px] rounded-[3px]" />
              Travel
            </span>
            <Segmented
              value={q.view}
              ariaLabel="View"
              onChange={(v) => go({ view: v, people: v === q.view ? q.people : null })}
              options={VIEWS}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2" data-testid="calendar-filters">
          {q.view === 'week' || q.view === 'day' || q.view === 'month' ? (
            <>
              <FilterLabel>Person</FilterLabel>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-[30px] items-center gap-[7px] rounded-full border border-border-strong bg-card pl-2.5 pr-2 text-[13px] font-medium"
                    data-testid="person-picker"
                  >
                    {focus ? (
                      <Avatar
                        name={focus.fullName}
                        seed={focus.userId}
                        size="sm"
                        className="-ml-1 h-5 w-5 text-[9px]"
                      />
                    ) : null}
                    {focus?.fullName ?? 'Nobody'}
                    <ChevronDown className="h-3.5 w-3.5 text-text-3" strokeWidth={1.5} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {people.map((p) => (
                    <DropdownMenuItem key={p.userId} onSelect={() => go({ people: [p.userId] })}>
                      <Avatar name={p.fullName} seed={p.userId} size="sm" />
                      {p.fullName}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="mx-1.5 h-[22px] w-px bg-border" />
            </>
          ) : null}
          <FilterLabel>Calendars</FilterLabel>
          {liveCalendars.length === 0 ? (
            <span className="text-[13px] text-text-3">None yet</span>
          ) : (
            liveCalendars.map((c) => {
              const on = !shownCalendars || shownCalendars.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleCalendar(c.id)}
                  data-testid={`filter-calendar-${c.id}`}
                  className={cn(
                    'inline-flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-full border pl-2.5 pr-[11px] text-[13px] font-medium',
                    on
                      ? 'border-border-strong bg-card text-text'
                      : 'border-dashed border-border-strong bg-transparent text-text-3',
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 flex-none rounded-[3px]"
                    style={
                      on ? { background: c.color } : { boxShadow: `inset 0 0 0 1.5px ${c.color}` }
                    }
                  />
                  {c.name}
                </button>
              );
            })
          )}
          {q.view === 'team' && people.length > 1 ? (
            <>
              <span className="mx-1.5 h-[22px] w-px bg-border" />
              <FilterLabel>People</FilterLabel>
              {people.map((p) => {
                const on = !q.people || q.people.includes(p.userId);
                return (
                  <button
                    key={p.userId}
                    type="button"
                    aria-pressed={on}
                    onClick={() => togglePerson(p.userId)}
                    data-testid={`filter-person-${p.userId}`}
                    className={cn(
                      'inline-flex h-[30px] items-center gap-[7px] whitespace-nowrap rounded-full border pl-2.5 pr-[11px] text-[13px] font-medium',
                      on
                        ? 'border-border-strong bg-card text-text'
                        : 'border-dashed border-border-strong bg-transparent text-text-3',
                    )}
                  >
                    <Avatar
                      name={p.fullName}
                      seed={p.userId}
                      size="sm"
                      className={cn('-ml-1 h-5 w-5 text-[9px]', !on && 'opacity-45')}
                    />
                    {firstName(p.fullName)}
                  </button>
                );
              })}
            </>
          ) : null}
        </div>

        {reconnect.map((p) => {
          const c = p.connection!;
          const mine = p.userId === myUserId;
          return (
            <div
              key={p.userId}
              className="flex flex-wrap items-center gap-3 rounded-menu bg-warning-soft px-3.5 py-2.5 text-[13px] text-warning-text"
              data-testid="reconnect-notice"
            >
              <AlertTriangle className="h-4 w-4 flex-none" strokeWidth={1.75} />
              <span className="min-w-0 flex-1">
                <strong className="font-semibold">
                  {mine ? 'Your' : `${firstName(p.fullName)}’s`} {calendarProviderName(c.provider)}{' '}
                  needs reconnecting.
                </strong>{' '}
                {c.busySyncedAt ? `Since ${relativeTime(c.busySyncedAt)} ` : 'Until then '}
                {mine ? 'your' : 'their'} busy times aren’t checked, so {mine ? 'you' : 'they'}{' '}
                could be booked over them.
              </span>
              {mine ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void connectCalendar(workspaceId, c.provider).catch((e: unknown) =>
                      toast.error(errorMessage(e)),
                    )
                  }
                >
                  Reconnect {calendarProviderName(c.provider)}
                </Button>
              ) : (
                <span className="text-xs">Only {firstName(p.fullName)} can do this.</span>
              )}
            </div>
          );
        })}

        {liveCalendars.length === 0 ? (
          <Card>
            <EmptyState
              title="No calendars yet"
              actions={
                canManage ? (
                  <ButtonLink
                    href={`/app/w/${workspaceId}/settings/calendars/new`}
                    variant="primary"
                    size="sm"
                  >
                    Set up a calendar
                  </ButtonLink>
                ) : undefined
              }
            >
              {canManage
                ? 'Start with a preset like Personal or Round Robin. It only takes a minute.'
                : 'An owner or admin sets calendars up in Settings.'}
            </EmptyState>
          </Card>
        ) : null}

        {(q.view === 'week' || q.view === 'day' || q.view === 'month') && focus ? (
          <div className="-mb-1 flex items-center justify-between text-xs">
            <span className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
              {focus.userId === myUserId ? 'Your' : `${firstName(focus.fullName)}’s`} {stepWord}
            </span>
            {focus.connection?.status === 'active' ? (
              <span className="flex items-center gap-1.5 text-text-3">
                <ProviderMark provider={focus.connection.provider} className="h-3.5 w-3.5" />
                {calendarProviderName(focus.connection.provider)} connected
                {focus.connection.busySyncedAt
                  ? ` · busy times checked ${relativeTime(focus.connection.busySyncedAt)}`
                  : ''}
              </span>
            ) : null}
          </div>
        ) : null}

        {q.view === 'month' ? (
          monthCells.length ? (
            <MonthGrid
              cells={monthCells}
              timeZone={tz}
              now={now}
              selectedId={q.appt}
              onOpen={(a) => go({ appt: a.id })}
              onNew={(d) => openNew({ date: d })}
              onDay={(d) => go({ view: 'day', date: d })}
            />
          ) : (
            <Card>
              <EmptyState title="Nobody to show">Pick someone to show.</EmptyState>
            </Card>
          )
        ) : columns.length ? (
          <TimeGrid
            columns={columns}
            timeZone={tz}
            hours={hours}
            now={now}
            draggable={fine}
            crossColumns={q.view === 'team' || q.view === 'week'}
            selectedId={q.appt}
            ghost={
              move
                ? { apptId: move.appt.id, colKey: move.to.key, top: move.top, bottom: move.bottom }
                : null
            }
            maxHeight="calc(100dvh - 236px)"
            minColumnWidth={q.view === 'day' ? 320 : q.view === 'week' ? 120 : 168}
            onSlot={(col, minutes) =>
              openNew({ date: col.date, start: minutesToClock(minutes), person: col.userId })
            }
            onOpen={(a) => go({ appt: a.id })}
            onMove={setMove}
          />
        ) : (
          <Card>
            <EmptyState title={q.view === 'resources' ? 'No resources yet' : 'Nobody to show'}>
              {q.view === 'resources'
                ? 'Rooms, trucks and equipment show here once they’re added in Settings.'
                : 'Pick someone to show.'}
            </EmptyState>
          </Card>
        )}
      </div>

      <div className="-mt-4 md:hidden">
        <Agenda
          timeZone={tz}
          date={date}
          today={today}
          days={q.view === 'month' ? weekOf(date) : days}
          appointments={visible}
          me={me}
          mine={!!q.people && q.people.length === 1 && q.people[0] === myUserId}
          now={now}
          onDate={(d) => go({ date: d })}
          onMine={(mine) => go({ people: mine ? [myUserId] : null })}
          onOpen={(a) => go({ appt: a.id })}
          onNew={() => openNew({ date })}
        />
        <button
          type="button"
          aria-label="New appointment"
          title="New appointment"
          data-testid="calendar-fab"
          onClick={() => openNew({ date })}
          className="fixed bottom-[82px] right-4 z-20 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-2"
        >
          <Plus className="h-6 w-6" strokeWidth={2} />
        </button>
      </div>

      {q.new ? (
        <AppointmentDialog
          open
          workspaceId={workspaceId}
          timeZone={tz}
          people={simplePeople}
          myUserId={myUserId}
          calendars={liveCalendars}
          prefill={{
            date: q.date,
            time: q.start,
            userId: q.person,
            calendarId: q.calendar,
            serviceId: q.service,
            personId: q.customer,
          }}
          onOpenChange={(o) => !o && go(CLOSED_NEW)}
          onBooked={booked}
        />
      ) : null}
      {q.appt ? (
        <AppointmentSheet
          key={q.appt}
          workspaceId={workspaceId}
          appointmentId={q.appt}
          timeZone={tz}
          people={simplePeople}
          myUserId={myUserId}
          myRole={props.role}
          onClose={() => go({ appt: null })}
          onChanged={() => router.refresh()}
        />
      ) : null}
      {move && moveTarget ? (
        <MoveDialog
          workspaceId={workspaceId}
          appt={move.appt}
          timeZone={tz}
          target={moveTarget}
          people={simplePeople}
          onClose={() => setMove(null)}
          onDone={() => {
            setMove(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
