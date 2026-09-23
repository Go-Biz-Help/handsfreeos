import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PermissionsSettings } from '@/components/settings/permissions-page';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Permissions' };

/** What the Admin and Member roles may do in this business (0105). Only an owner sets it. */
export default async function PermissionsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'permissions.manage')) notFound();
  const settings = unwrapPage(
    await api.POST('/v1/queries/permission.settings', { body: { workspaceId } }),
  );
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} permissions={got.workspace.permissions} />
      <PermissionsSettings
        workspaceId={workspaceId}
        roles={settings.roles}
        people={settings.people}
      />
    </>
  );
}
