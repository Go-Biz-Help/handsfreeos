import { hasWorkspacePermission } from '@hfos/core';
import type { ReactNode } from 'react';
import { KnowledgeHeaderActions } from '@/components/knowledge/header-actions';
import { KnowledgeSubnav } from '@/components/knowledge/subnav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

/**
 * The Knowledge section: one header and the subnav (with how many suggestions are waiting) over every page.
 * Everyone reads it; owners and admins (knowledge.manage) change it.
 */
export default async function KnowledgeLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, waiting] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_suggestion.list', {
      body: { workspaceId, status: 'pending', limit: 100 },
    }),
  ]);
  const { workspace } = unwrapPage(ws);
  const pending = unwrapPage(waiting);
  const canManage = hasWorkspacePermission(workspace.role, 'knowledge.manage');
  return (
    <div className="mx-auto w-full max-w-[1240px]">
      <PageHeader
        title="Knowledge"
        description={
          canManage
            ? `What AI steps and the Assistant know about ${workspace.name}. They only use what’s published here, and never quote prices unless you allow it.`
            : `What AI steps and the Assistant know about ${workspace.name}. Only owners and admins can change it.`
        }
        actions={canManage ? <KnowledgeHeaderActions workspaceId={workspaceId} /> : null}
      />
      <KnowledgeSubnav
        workspaceId={workspaceId}
        pending={pending.items.length}
        more={!!pending.nextCursor}
      />
      {children}
    </div>
  );
}
