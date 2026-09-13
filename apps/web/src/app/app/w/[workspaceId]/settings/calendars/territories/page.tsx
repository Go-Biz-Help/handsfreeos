import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CalendarsSubnav } from '@/components/calendars/subnav';
import { TerritoriesPage } from '@/components/calendars/territories-page';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Territories' };

export default async function TerritoriesSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (got.workspace.role !== 'owner' && got.workspace.role !== 'admin') notFound();
  const [territories, members] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/territory.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage />
      <CalendarsSubnav workspaceId={workspaceId} />
      <TerritoriesPage
        workspaceId={workspaceId}
        territories={territories.items}
        people={assigneeOptions(members)}
      />
    </>
  );
}
