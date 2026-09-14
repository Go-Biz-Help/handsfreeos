import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/shell/page-header';
import { ApprovalsBoard } from '@/components/workflows/approvals/approvals-board';
import type { Approval } from '@/components/workflows/approvals/types';
import { WorkflowsSubnav } from '@/components/workflows/subnav';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Approvals' };

/** How many decided approvals the Decided view lists. */
const DECIDED = 30;

/**
 * Approval steps waiting for the viewer (owners and admins see every one, named approvers theirs), and the
 * ones decided or expired lately.
 */
export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api, userId } = await apiServer();
  const list = async (status: 'pending' | 'approved' | 'rejected' | 'expired') =>
    unwrapPage(
      await api.POST('/v1/queries/workflow.approval_list', {
        body: { workspaceId, status, limit: status === 'pending' ? 100 : DECIDED },
      }),
    ).items;
  const [got, pending, approved, rejected, expired, profile] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    list('pending'),
    list('approved'),
    list('rejected'),
    list('expired'),
    // Whether the AI may quote prices, beside the knowledge an AI text used (the page works without it).
    api
      .POST('/v1/queries/knowledge.profile', { body: { workspaceId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  const manages = hasWorkspacePermission(got.workspace.role, 'workflows.manage');
  const mine = (a: Approval) => manages || a.approvers.some((u) => u.id === userId);
  const at = (a: Approval) => Date.parse(a.decidedAt ?? a.createdAt);
  const decided = [...approved, ...rejected, ...expired]
    .filter(mine)
    .sort((x, y) => at(y) - at(x))
    .slice(0, DECIDED);
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Approvals: steps that wait for a person before they text or email. Owners and admins see every one; named people see theirs."
      />
      <WorkflowsSubnav workspaceId={workspaceId} />
      <ApprovalsBoard
        workspaceId={workspaceId}
        waiting={pending.filter((a) => a.canDecide)}
        decided={decided}
        allowPrices={profile ? profile.profile.allowPrices : null}
        serverNow={Date.now()}
      />
    </>
  );
}
