import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ResourcesPage } from '@/components/calendars/resources-page';
import { CalendarsSubnav } from '@/components/calendars/subnav';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Resources' };

export default async function ResourcesSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (got.workspace.role !== 'owner' && got.workspace.role !== 'admin') notFound();
  const resources = unwrapPage(
    await api.POST('/v1/queries/resource.list', { body: { workspaceId } }),
  );
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage />
      <CalendarsSubnav workspaceId={workspaceId} />
      <ResourcesPage workspaceId={workspaceId} resources={resources.items} />
    </>
  );
}
