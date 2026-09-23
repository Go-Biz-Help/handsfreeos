import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RelationshipsSettings } from '@/components/settings/relationships-settings';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Relationships' };

export default async function RelationshipsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'fields.manage')) notFound();
  const [kinds, types] = await Promise.all([
    api.POST('/v1/queries/custom_record_type.list', {
      body: { workspaceId, includeArchived: true },
    }),
    api.POST('/v1/queries/relationship_type.list', {
      body: { workspaceId, includeArchived: true },
    }),
  ]);
  return (
    <>
      <PageHeader title="Settings" description={`How ${got.workspace.name} is set up.`} />
      <SettingsNav workspaceId={workspaceId} permissions={got.workspace.permissions} />
      <RelationshipsSettings
        workspaceId={workspaceId}
        kinds={unwrapPage(kinds).types}
        types={unwrapPage(types).types}
      />
    </>
  );
}
