import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PipelinesEditor } from '@/components/settings/pipelines-editor';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Pipelines' };

export default async function PipelinesSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'pipelines.manage')) notFound();
  const { pipelines } = unwrapPage(
    await api.POST('/v1/queries/pipeline.list', { body: { workspaceId } }),
  );
  return (
    <>
      <PageHeader title="Settings" description={`How ${got.workspace.name} is set up.`} />
      <SettingsNav workspaceId={workspaceId} permissions={got.workspace.permissions} />
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">Pipelines and stages</h2>
        <p className="text-[13px] text-text-2">
          Leads move left to right. A stage with leads keeps its kind; deleting one moves its leads
          to another stage of the same kind.
        </p>
      </div>
      <PipelinesEditor workspaceId={workspaceId} pipelines={pipelines} />
    </>
  );
}
