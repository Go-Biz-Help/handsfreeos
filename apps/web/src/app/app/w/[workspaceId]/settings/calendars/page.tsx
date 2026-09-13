import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarsList } from '@/components/calendars/calendars-list';
import { CalendarsSubnav } from '@/components/calendars/subnav';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Calendars' };

/** Owners and admins: every calendar with its labels, link, status and the next seven days. */
export default async function CalendarsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (got.workspace.role !== 'owner' && got.workspace.role !== 'admin') notFound();
  const list = unwrapPage(
    await api.POST('/v1/queries/calendar.list', { body: { workspaceId, includeArchived: true } }),
  );
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage />
      <CalendarsSubnav workspaceId={workspaceId} />
      <CalendarsList workspaceId={workspaceId} items={list.items} site={list.site} />
    </>
  );
}
