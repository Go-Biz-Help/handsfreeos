import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RunDetail } from '@/components/workflows/runs/run-detail';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Run' };

const ID = /^[0-9a-f-]{36}$/i;

/** One run: the path it took, what each step did, and Retry, Skip or Stop for owners and admins. */
export default async function WorkflowRunPage({
  params,
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = await params;
  if (!ID.test(runId)) notFound();
  const { api } = await apiServer();
  const [ws, run, catalogs] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/workflow.run_get', { body: { workspaceId, runId } }),
    api.POST('/v1/queries/workflow.catalogs', { body: { workspaceId } }),
  ]);
  const got = unwrapPage(ws);
  const loaded = unwrapPage(catalogs).catalogs;
  return (
    <RunDetail
      key={runId}
      workspaceId={workspaceId}
      initial={unwrapPage(run)}
      catalogs={loaded}
      timeZone={loaded.timeZone}
      canManage={hasWorkspacePermission(got.workspace.role, 'workflows.manage')}
    />
  );
}
