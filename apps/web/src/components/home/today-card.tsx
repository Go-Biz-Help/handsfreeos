'use client';
import { CalendarDays, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { areaOf, customersOf, firstName, namesText, useNow } from '@/components/calendar/appt';
import { ZoneChip } from '@/components/settings/my-calendar';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { apiBrowser, errorMessage, unwrap } from '@/lib/api/client';
import type { Appointment, Task } from '@/lib/api/types';
import { dateOf, fmtTime } from '@/lib/calendar/time';
import { calendarHref } from '@/lib/calendar/url';
import { cn } from '@/lib/utils';
import { FoldButton } from './attention-bits';

export interface TodayProps {
  readonly workspaceId: string;
  readonly timeZone: string;
  readonly today: string;
  readonly tomorrow: string;
  /** The next few days' appointments (only today's and tomorrow's count here). */
  readonly items: readonly Appointment[];
  readonly myUserId: string;
  /** Whose: it follows Home's Mine / Everyone. */
  readonly who: 'mine' | 'all';
  /** Open tasks: the ones due today show under the appointments. */
  readonly tasks: readonly Task[];
  /** Attendees with an open "not confirmed" item. */
  /** Appointments with an open "not confirmed" item. */
  readonly unconfirmed: ReadonlySet<string>;
}

/** The customer has confirmed: every booked seat says so (a one-on-one booking is the only kind ever asked). */
function isConfirmed(a: Appointment): boolean {
  const booked = a.attendees.filter((t) => t.status === 'booked');
  return booked.length > 0 && booked.every((t) => t.confirmedAt !== null);
}

function todayOf(p: TodayProps, now: number | null) {
  const shown = p.items.filter(
    (a) => p.who === 'all' || a.staff.some((s) => s.userId === p.myUserId),
  );
  const onDay = shown
    .filter((a) => dateOf(a.startsAt, p.timeZone) === p.today)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const done = now === null ? [] : onDay.filter((a) => Date.parse(a.endsAt) <= now);
  const left = onDay.filter((a) => !done.includes(a));
  const next = shown.filter((a) => dateOf(a.startsAt, p.timeZone) === p.tomorrow).length;
  const due = p.tasks.filter(
    (t) =>
      t.dueBucket === 'today' && !t.doneAt && (p.who === 'all' || t.assignee?.id === p.myUserId),
  );
  const unconfirmed = left.filter((a) => p.unconfirmed.has(a.id)).length;
  // How many of tomorrow's the customers have confirmed so far.
  const confirmedNext = shown.filter(
    (a) => dateOf(a.startsAt, p.timeZone) === p.tomorrow && isConfirmed(a),
  ).length;
  return { onDay, done, left, next, due, unconfirmed, confirmedNext };
}

const isLive = (a: Appointment, now: number | null) =>
  now !== null && Date.parse(a.startsAt) <= now && Date.parse(a.endsAt) > now;

/** The customer when there's one, else the appointment's title. */
function nameOf(a: Appointment): string {
  const customers = customersOf(a);
  return customers.length === 1 ? customers[0]!.fullName : a.title;
}

function Status({ tone, children }: { tone: 'live' | 'no' | 'yes'; children: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 flex-none items-center whitespace-nowrap rounded-[6px] px-1.5 text-[11.5px] font-medium',
        tone === 'live'
          ? 'bg-accent-soft text-accent-text'
          : tone === 'yes'
            ? 'bg-success-soft text-success-text'
            : 'bg-warning-soft text-warning-text',
      )}
    >
      {children}
    </span>
  );
}

function TodayBody({ p }: { p: TodayProps }) {
  const router = useRouter();
  const now = useNow();
  const t = todayOf(p, now);
  const [busy, setBusy] = useState<string | null>(null);

  async function complete(task: Task) {
    setBusy(task.id);
    const api = apiBrowser();
    try {
      unwrap(
        await api.POST('/v1/commands/task.complete', {
          body: { workspaceId: p.workspaceId, taskId: task.id },
        }),
      );
      toast(`Done: ${task.title}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            api
              .POST('/v1/commands/task.reopen', {
                body: { workspaceId: p.workspaceId, taskId: task.id },
              })
              .then(unwrap)
              .then(() => router.refresh())
              .catch((e: unknown) => toast.error(errorMessage(e)));
          },
        },
        duration: 6000,
      });
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {t.left.length === 0 ? (
        <div className="flex flex-col items-center gap-1 border-t border-border px-6 py-6 text-center">
          <span className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-card-2 text-text-3">
            <CalendarDays className="h-[18px] w-[18px]" strokeWidth={1.5} />
          </span>
          <span className="text-sm font-semibold">
            {t.onDay.length ? 'Nothing more today' : 'Nothing booked today'}
          </span>
          <span className="max-w-[260px] text-[13px] text-text-2">
            Open times can still be booked online.
          </span>
          <ButtonLink
            href={calendarHref(p.workspaceId, { new: true, date: p.today })}
            variant="secondary"
            size="sm"
            className="mt-2"
          >
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New appointment
          </ButtonLink>
        </div>
      ) : (
        <ul>
          {t.left.map((a) => {
            const customers = customersOf(a);
            const staff = namesText(a.staff.map((s) => firstName(s.fullName)));
            const detail = [
              customers.length === 1 ? a.title : null,
              staff,
              customers.length === 1
                ? null
                : a.capacity > 1
                  ? `${a.seatsTaken} of ${a.capacity} seats`
                  : areaOf(a.location.address),
            ]
              .filter(Boolean)
              .join(' · ');
            const unconfirmed = p.unconfirmed.has(a.id);
            return (
              <li key={a.id}>
                <Link
                  href={calendarHref(p.workspaceId, { appt: a.id })}
                  className="flex items-center gap-2.5 border-t border-border px-4 py-2 hover:bg-card-2"
                  data-testid={`today-${a.id}`}
                >
                  <span className="w-[62px] flex-none text-[13px] font-medium tabular-nums">
                    {fmtTime(a.startsAt, p.timeZone)}
                  </span>
                  <span
                    className="w-[3px] flex-none self-stretch rounded-[3px]"
                    style={{ background: a.calendar.color }}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">{nameOf(a)}</span>
                    <span className="truncate text-xs text-text-3">{detail}</span>
                  </span>
                  {isLive(a, now) ? (
                    <Status tone="live">Now</Status>
                  ) : unconfirmed ? (
                    <Status tone="no">Not confirmed</Status>
                  ) : isConfirmed(a) ? (
                    <Status tone="yes">Confirmed</Status>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {t.due.length ? (
        <>
          <div className="border-t border-border px-4 pb-[5px] pt-[9px] text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">
            Tasks due today
          </div>
          <ul>
            {t.due.map((task) => {
              const sub = [
                task.person?.fullName ?? task.lead?.title ?? task.company?.name ?? null,
                p.who === 'all' && task.assignee
                  ? task.assignee.id === p.myUserId
                    ? 'you'
                    : firstName(task.assignee.fullName)
                  : null,
                task.allDay || !task.dueAt ? 'due today' : `due ${fmtTime(task.dueAt, p.timeZone)}`,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li
                  key={task.id}
                  data-testid="today-task"
                  className="flex items-center gap-2.5 border-t border-border px-4 py-2"
                >
                  <button
                    type="button"
                    aria-label={`Mark “${task.title}” done`}
                    disabled={busy === task.id}
                    onClick={() => void complete(task)}
                    className="h-[18px] w-[18px] flex-none rounded-full border-[1.5px] border-border-strong transition-colors hover:border-accent disabled:opacity-50"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px]">{task.title}</span>
                    <span className="truncate text-xs text-text-3">{sub}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <div className="border-t border-border bg-card-2 px-4 py-[9px] text-xs text-text-3">
        {t.next > 0
          ? `${t.next} tomorrow · ${t.confirmedNext} confirmed so far`
          : `${t.done.length} done earlier today · 0 tomorrow`}
      </div>
    </>
  );
}

/**
 * Home's Today, in the side rail: what's on today (whose follows Mine / Everyone), which visits aren't confirmed,
 * the tasks due today, and tomorrow's count.
 */
export function TodayCard(p: TodayProps) {
  return (
    <Card className="overflow-hidden" data-testid="today-card">
      <div className="flex flex-wrap items-center gap-2 px-4 pb-[9px] pt-[13px]">
        <h2 className="flex-1 text-[15px] font-semibold">Today</h2>
        <ZoneChip timeZone={p.timeZone} />
        <Link
          href={`/app/w/${p.workspaceId}/calendar`}
          className="text-[13px] font-medium text-accent-text hover:underline"
        >
          Open calendar
        </Link>
      </div>
      <TodayBody p={p} />
    </Card>
  );
}

/** On a phone Today folds below the list, and opens in place. */
export function TodayFold(p: TodayProps) {
  const now = useNow();
  const [open, setOpen] = useState(false);
  const t = todayOf(p, now);
  const n = t.onDay.length;
  const first = t.left[0];
  const sub = [
    first
      ? `${fmtTime(first.startsAt, p.timeZone)} ${nameOf(first)}${isLive(first, now) ? ', now' : ''}`
      : n
        ? 'Nothing more today'
        : 'Nothing booked',
    t.unconfirmed ? `${t.unconfirmed} not confirmed` : null,
    t.due.length ? `${t.due.length} ${t.due.length === 1 ? 'task' : 'tasks'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div data-testid="today-fold">
      <FoldButton
        open={open}
        onToggle={() => setOpen(!open)}
        icon={
          <span
            aria-hidden
            className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-card-2 text-text-2"
          >
            <CalendarDays className="h-[13px] w-[13px]" strokeWidth={1.75} />
          </span>
        }
        title={`Today · ${n} ${n === 1 ? 'appointment' : 'appointments'}`}
        sub={sub}
      />
      {open ? (
        <div
          className="overflow-hidden rounded-b-card border border-t-0 border-border-strong bg-card"
          data-testid="today-fold-body"
        >
          <TodayBody p={p} />
        </div>
      ) : null}
    </div>
  );
}
