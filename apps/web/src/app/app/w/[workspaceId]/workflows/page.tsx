import { can } from '@hfos/core';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { WorkflowList } from '@/components/workflows/workflow-list';
import { WorkflowsSubnav } from '@/components/workflows/subnav';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Workflows' };

/** Everyone can see the workflows; owners and admins add and change them. */
export default async function WorkflowsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = can(got.workspace.permissions, 'workflows.manage');
  const [listRes, statsRes] = await Promise.all([
    api.POST('/v1/queries/workflow.list', { body: { workspaceId } }),
    api.POST('/v1/queries/workflow.stats', { body: { workspaceId } }),
  ]);
  const list = unwrapPage(listRes);
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Follow-ups that run on their own. Each one is tested before it goes live, and you can pause it any time."
        actions={
          canManage ? (
            <ButtonLink
              href={`/app/w/${workspaceId}/workflows/new`}
              variant="primary"
              data-testid="workflow-new"
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New workflow
            </ButtonLink>
          ) : null
        }
      />
      <WorkflowsSubnav workspaceId={workspaceId} />
      <WorkflowList
        workspaceId={workspaceId}
        items={list.items}
        canManage={canManage}
        stats={statsRes.data ?? null}
        timeZone={got.workspace.timezone}
      />
    </>
  );
}
