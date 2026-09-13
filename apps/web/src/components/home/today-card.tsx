'use client';
import { CalendarDays, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { areaOf, customersOf, firstName, namesText, useNow } from '@/components/calendar/appt';
import { ZoneChip } from '@/components/settings/my-calendar';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Segmented } from '@/components/ui/segmented';
import type { Appointment } from '@/lib/api/types';
import { dateOf, fmtTime } from '@/lib/calendar/time';
import { calendarHref } from '@/lib/calendar/url';

/** Home's Today card: what's on today (mine or everyone's), what already happened and tomorrow's count. */
export function TodayCard({
  workspaceId,
  timeZone,
  today,
  tomorrow,
  items,
  myUserId,
}: {
  workspaceId: string;
  timeZone: string;
  today: string;
  tomorrow: string;
  /** Today's and tomorrow's appointments. */
  items: readonly Appointment[];
  myUserId: string;
}) {
  const now = useNow();
  const [who, setWho] = useState<'mine' | 'all'>('all');
  const shown = items.filter((a) => who === 'all' || a.staff.some((s) => s.userId === myUserId));
  const onDay = shown
    .filter((a) => dateOf(a.startsAt, timeZone) === today)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const done = now === null ? [] : onDay.filter((a) => Date.parse(a.endsAt) <= now);
  const left = onDay.filter((a) => !done.includes(a));
  const next = shown.filter((a) => dateOf(a.startsAt, timeZone) === tomorrow).length;
  const open = (id: string) => calendarHref(workspaceId, { appt: id });

  return (
    <Card className="overflow-hidden" data-testid="today-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-2.5 pt-3.5">
        <span className="flex items-center gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Today</h2>
          <ZoneChip timeZone={timeZone} />
        </span>
        <span className="flex items-center gap-3">
          <Segmented
            value={who}
            onChange={setWho}
            ariaLabel="Whose appointments"
            options={[
              { value: 'mine', label: 'Mine' },
              { value: 'all', label: 'Everyone' },
            ]}
          />
          <Link
            href={`/app/w/${workspaceId}/calendar`}
            className="text-[13px] font-medium text-accent-text hover:underline"
          >
            Open calendar
          </Link>
        </span>
      </div>
      {left.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 border-t border-border px-6 py-8 text-center">
          <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-card-2 text-text-3">
            <CalendarDays className="h-5 w-5" strokeWidth={1.5} />
          </span>
          <span className="text-[15px] font-semibold">
            {onDay.length ? 'Nothing more today' : 'Nothing booked today'}
          </span>
          <span className="max-w-[300px] text-[13px] text-text-2">
            Open times can still be booked online.
          </span>
          <ButtonLink
            href={calendarHref(workspaceId, { new: true, date: today })}
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
          {left.map((a) => {
            const customers = customersOf(a);
            const live =
              now !== null && Date.parse(a.startsAt) <= now && Date.parse(a.endsAt) > now;
            const detail = [
              namesText(a.staff.map((s) => firstName(s.fullName))),
              ...a.resources.map((r) => r.name),
              a.capacity > 1
                ? `${a.seatsTaken} of ${a.capacity} seats`
                : areaOf(a.location.address),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={a.id}>
                <Link
                  href={open(a.id)}
                  className="flex items-center gap-3 border-t border-border px-5 py-[7px] hover:bg-card-2"
                  data-testid={`today-${a.id}`}
                >
                  <span className="w-[70px] flex-none text-[13px] font-medium tabular-nums">
                    {fmtTime(a.startsAt, timeZone)}
                  </span>
                  <span
                    className="w-[3px] flex-none self-stretch rounded-[3px]"
                    style={{ background: a.calendar.color }}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] font-medium">
                      {a.title}
                      {customers.length === 1 ? ` · ${customers[0]!.fullName}` : ''}
                    </span>
                    <span className="truncate text-xs text-text-3">{detail}</span>
                  </span>
                  {live ? (
                    <Badge variant="pending" className="h-5 text-[11.5px]">
                      Now
                    </Badge>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-border bg-card-2 px-5 py-[9px] text-xs text-text-3">
        {done.length} done earlier today · {next} tomorrow
      </div>
    </Card>
  );
}
