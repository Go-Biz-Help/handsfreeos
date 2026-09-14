import { hasWorkspacePermission } from '@hfos/core';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { RunsList } from '@/components/workflows/runs/runs-list';
import { WorkflowsSubnav } from '@/components/workflows/subnav';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { parseRunFilters, runListBody } from '@/lib/workflows/run-filters';

export const metadata: Metadata = { title: 'Runs' };

/** Every run, step by step (`?workflow=&status=&tests=1&range=`). Everyone can look. */
export default async function WorkflowRunsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const filters = parseRunFilters(await searchParams);
  const { api } = await apiServer();
  const [ws, list, runs, stats] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/workflow.list', { body: { workspaceId, includeArchived: true } }),
    api.POST('/v1/queries/workflow.run_list', {
      body: runListBody(workspaceId, filters, Date.now()),
    }),
    api.POST('/v1/queries/workflow.stats', { body: { workspaceId } }),
  ]);
  const got = unwrapPage(ws);
  const canManage = hasWorkspacePermission(got.workspace.role, 'workflows.manage');
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Every run, step by step. Runs finish on the version they started on."
        actions={
          canManage ? (
            <ButtonLink href={`/app/w/${workspaceId}/workflows/new`} variant="primary">
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New workflow
            </ButtonLink>
          ) : null
        }
      />
      <WorkflowsSubnav workspaceId={workspaceId} />
      <RunsList
        workspaceId={workspaceId}
        initial={unwrapPage(runs)}
        initialFilters={filters}
        workflows={unwrapPage(list).items.map((w) => ({ id: w.id, name: w.name }))}
        stats={stats.data ?? null}
        timeZone={got.workspace.timezone}
      />
    </>
  );
}
