import { localInstant, monthGridOf, weekOf } from '@hfos/core';
import type { Metadata } from 'next';
import { CalendarPage } from '@/components/calendar/calendar-page';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { todayIn } from '@/lib/calendar/time';
import { parseCalendarQuery } from '@/lib/calendar/url';

export const metadata: Metadata = { title: 'Calendar' };

/**
 * /calendar: Team day (a column per person), Week, Day and Resources, and an agenda on phones. The whole
 * week around the chosen date loads at once; filters, the open appointment and New appointment live in the
 * URL (`?view=&date=&people=&calendars=&appt=&new=1`).
 */
export default async function CalendarRoute({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const timeZone = got.workspace.timezone;
  const today = todayIn(timeZone);
  const query = parseCalendarQuery(sp, today);
  // Month loads its whole six-week grid at once, the way the other views load their week: 42 days is
  // well inside the 62 the schedule and appointment queries allow.
  const days = query.view === 'month' ? monthGridOf(query.date) : weekOf(query.date);
  const from = new Date(localInstant(days[0]!, '00:00', timeZone)).toISOString();
  const to = new Date(localInstant(days.at(-1)!, '24:00', timeZone)).toISOString();
  const [calendars, resources, team, appointments] = await Promise.all([
    api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/resource.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/schedule.team', { body: { workspaceId, from, to } }).then(unwrapPage),
    api.POST('/v1/queries/appointment.list', { body: { workspaceId, from, to } }).then(unwrapPage),
  ]);
  return (
    <CalendarPage
      workspaceId={workspaceId}
      myUserId={userId}
      permissions={got.workspace.permissions}
      timeZone={timeZone}
      today={today}
      query={query}
      days={days}
      calendars={calendars.items}
      resources={resources.items}
      people={team.people}
      appointments={appointments.items}
    />
  );
}
