import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServicesPage } from '@/components/calendars/services-page';
import { CalendarsSubnav } from '@/components/calendars/subnav';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Services' };

export default async function ServicesSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'calendars.manage')) notFound();
  const [services, resources, members] = await Promise.all([
    api.POST('/v1/queries/service.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/resource.list', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <>
      <CalendarsSubnav workspaceId={workspaceId} />
      <ServicesPage
        workspaceId={workspaceId}
        services={services.items}
        resources={resources.items}
        people={assigneeOptions(members)}
      />
    </>
  );
}
