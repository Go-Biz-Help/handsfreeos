import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ResourcesPage } from '@/components/calendars/resources-page';
import { CalendarsSubnav } from '@/components/calendars/subnav';
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
  if (!can(got.workspace.permissions, 'calendars.manage')) notFound();
  const resources = unwrapPage(
    await api.POST('/v1/queries/resource.list', { body: { workspaceId } }),
  );
  return (
    <>
      <CalendarsSubnav workspaceId={workspaceId} />
      <ResourcesPage workspaceId={workspaceId} resources={resources.items} />
    </>
  );
}
