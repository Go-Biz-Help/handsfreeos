import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ServicesPage } from '@/components/calendars/services-page';
import { CalendarsSubnav } from '@/components/calendars/subnav';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
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
    unwrapPage(await api.POST('/v1/queries/service.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/resource.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} permissions={got.workspace.permissions} />
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
