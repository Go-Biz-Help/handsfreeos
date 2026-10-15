import { ADDON_CATALOG, can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MyCalendar } from '@/components/settings/my-calendar';
import { ZoomCoachCard } from '@/components/settings/zoom-coach-card';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'My calendar' };

const DAY = 86_400_000;

/**
 * Everyone's own hours, time off and Google or Outlook connection. Owners and admins open someone else's
 * from Members (`?user=`). Coming back from Google's or Microsoft's sign-in carries `?calendar=`, and from Zoom's `?meeting=`.
 */
export default async function MyCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { calendar, meeting, user } = await searchParams;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
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
  const [team, connections, meetings] = await Promise.all([
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
  ]);
  const person = team.people[0];
  if (!person) notFound();
  // The coaching Zoom app, for someone an add-on that hears Zoom meetings would coach (their own card only).
  const coached =
    targetId === userId &&
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
  return (
    <>
      <MyCalendar
        workspaceId={workspaceId}
        person={person}
        connection={connections.items.find((c) => c.status !== 'pending') ?? null}
        meeting={meetings.items.find((c) => c.status !== 'pending') ?? null}
        isSelf={targetId === userId}
        canManage={canManage}
        result={targetId === userId && typeof calendar === 'string' ? calendar : null}
        meetingResult={targetId === userId && typeof meeting === 'string' ? meeting : null}
      />
      {coached ? <ZoomCoachCard workspaceId={workspaceId} account={coach} /> : null}
    </>
  );
}
