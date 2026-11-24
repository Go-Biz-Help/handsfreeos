import { ADDON_CATALOG, can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MyCalendar } from '@/components/settings/my-calendar';
import { MyCalendarOverview } from '@/components/settings/my-calendar-overview';
import { ZoomCoachCard } from '@/components/settings/zoom-coach-card';
import { apiServer, getWorkspace, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'My calendar' };

const DAY = 86_400_000;

/**
 * Everyone's own hours, time off and Google or Outlook connection. Your own is one simple card (the owner, 24 Nov 2026,
 * M3 a): until it's set up, Start opens the guided setup (M1 a); after it, your calendar with Sync now and the setup's
 * answers, each with Change; and this page as it was under All settings. Owners and admins open someone else's from
 * Members (`?user=`), which is this page alone. Coming back from Google's or Microsoft's sign-in carries `?calendar=`,
 * and from Zoom's `?meeting=`, which open All settings; settings search's `?all=1` does too.
 */
export default async function MyCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { calendar, meeting, user, all } = await searchParams;
  const { api, userId } = await apiServer();
  const got = await getWorkspace(workspaceId);
  const canManage = can(got.workspace.permissions, 'calendars.manage');
  const targetId = typeof user === 'string' && canManage ? user : userId;
  const members = unwrapPage(
    await api.POST('/v1/queries/workspace.members', { body: { workspaceId } }),
  );
  const known = [...members.members, ...members.organizationAdmins].some(
    (m) => m.userId === targetId,
  );
  if (!known) notFound();
  const now = Date.now();
  const isSelf = targetId === userId;
  const [team, connections, meetings, dayStart, mine, draft] = await Promise.all([
    api
      .POST('/v1/queries/schedule.team', {
        body: {
          workspaceId,
          from: new Date(now - DAY).toISOString(),
          to: new Date(now + 60 * DAY).toISOString(),
          userIds: [targetId],
        },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/calendar_connection.list', {
        body: { workspaceId, userId: targetId },
      })
      .then(unwrapPage),
    api
      .POST('/v1/queries/meeting_connection.list', {
        body: { workspaceId, userId: targetId },
      })
      .then(unwrapPage),
    // Where their day starts (decision 179): the page still opens if it can't be read.
    api
      .POST('/v1/queries/day_start.get', { body: { workspaceId, userId: targetId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
    // Your own calendar as the guided setup reads it. The web ships a little before the API: until it answers, this
    // page is what there is.
    isSelf
      ? api
          .POST('/v1/queries/my_calendar_setup.get', { body: { workspaceId } })
          .then((r) => r.data ?? null)
          .catch(() => null)
      : null,
    isSelf
      ? api
          .POST('/v1/queries/guided_setup.get_draft', {
            body: { workspaceId, setup: 'my_calendar' },
          })
          .then((r) => r.data?.answers ?? null)
          .catch(() => null)
      : null,
  ]);
  const person = team.people[0];
  if (!person) notFound();
  // The coaching Zoom app, for someone an add-on that hears Zoom meetings would coach (their own card only).
  const coached =
    isSelf &&
    ADDON_CATALOG.some(
      (m) => m.liveCalls?.zoom && got.workspace.permissions.includes(m.liveCalls.permission),
    );
  const coach = coached
    ? (
        await api
          .POST('/v1/queries/live_meeting_account.mine', { body: { workspaceId } })
          .then(unwrapPage)
      ).account
    : null;
  const page = (
    <>
      <MyCalendar
        workspaceId={workspaceId}
        person={person}
        businessZone={team.timezone}
        connection={connections.items.find((c) => c.status !== 'pending') ?? null}
        meeting={meetings.items.find((c) => c.status !== 'pending') ?? null}
        dayStart={dayStart}
        isSelf={isSelf}
        canManage={canManage}
        result={isSelf && typeof calendar === 'string' ? calendar : null}
        meetingResult={isSelf && typeof meeting === 'string' ? meeting : null}
      />
      {coached ? <ZoomCoachCard workspaceId={workspaceId} account={coach} /> : null}
    </>
  );
  // Someone whose role doesn't take appointments has nothing to set up, so the page stays as it was.
  if (!mine || !can(got.workspace.permissions, 'appointments.write')) return page;
  return (
    <MyCalendarOverview
      workspaceId={workspaceId}
      ctx={mine}
      started={draft !== null}
      openAll={all === '1' || typeof calendar === 'string' || typeof meeting === 'string'}
    >
      {page}
    </MyCalendarOverview>
  );
}
