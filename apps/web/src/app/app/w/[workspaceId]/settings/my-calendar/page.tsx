import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MyCalendar } from '@/components/settings/my-calendar';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'My calendar' };

const DAY = 86_400_000;

/**
 * Everyone's own hours, time off and Google or Outlook connection. Owners and admins open someone else's
 * from Members (`?user=`). Coming back from Google's or Microsoft's sign-in carries `?calendar=`.
 */
export default async function MyCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const { calendar, user } = await searchParams;
  const { api, userId } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const role = got.workspace.role;
  const canManage = hasWorkspacePermission(role, 'calendars.manage');
  const targetId = typeof user === 'string' && canManage ? user : userId;
  const members = unwrapPage(
    await api.POST('/v1/queries/workspace.members', { body: { workspaceId } }),
  );
  const known = [...members.members, ...members.organizationAdmins].some(
    (m) => m.userId === targetId,
  );
  if (!known) notFound();
  const now = Date.now();
  const [team, connections] = await Promise.all([
    unwrapPage(
      await api.POST('/v1/queries/schedule.team', {
        body: {
          workspaceId,
          from: new Date(now - DAY).toISOString(),
          to: new Date(now + 60 * DAY).toISOString(),
          userIds: [targetId],
        },
      }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/calendar_connection.list', {
        body: { workspaceId, userId: targetId },
      }),
    ),
  ]);
  const person = team.people[0];
  if (!person) notFound();
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage={role === 'owner' || role === 'admin'} />
      <MyCalendar
        workspaceId={workspaceId}
        person={person}
        connection={connections.items.find((c) => c.status !== 'pending') ?? null}
        isSelf={targetId === userId}
        canManage={canManage}
        result={targetId === userId && typeof calendar === 'string' ? calendar : null}
      />
    </>
  );
}
