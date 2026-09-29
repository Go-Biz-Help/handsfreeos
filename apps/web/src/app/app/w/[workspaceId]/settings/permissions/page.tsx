import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PermissionsSettings } from '@/components/settings/permissions-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Permissions' };

/** What the Admin and Member roles may do in this business (0106). Only an owner sets it. */
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
      <PermissionsSettings
        workspaceId={workspaceId}
        roles={settings.roles}
        people={settings.people}
      />
    </>
  );
}
