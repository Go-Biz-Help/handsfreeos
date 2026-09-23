import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { PageHeader } from '@/components/shell/page-header';
import {
  ApprovalsBoard,
  type ApprovalsFilter,
} from '@/components/workflows/approvals/approvals-board';
import type { Approval } from '@/components/workflows/approvals/types';
import { WorkflowsSubnav } from '@/components/workflows/subnav';
import type { TeammateDraft } from '@/lib/ai-team/inbox-types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Approvals' };

/** How many decided approvals the Decided view lists. */
const DECIDED = 30;

const FILTERS: readonly ApprovalsFilter[] = ['all', 'workflows', 'ai'];

/**
 * What waits for the viewer's yes: workflow approval steps (owners and admins see every one, named approvers
 * theirs) and the AI teammate's drafts, with the ones decided or expired lately. `?filter=ai` opens on the
 * teammate's drafts (the AI teammate area links here).
 */
export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const asked = (await searchParams).filter;
  const initialFilter = FILTERS.find((f) => f === asked) ?? 'all';
  const { api, userId } = await apiServer();
  // The teammate's drafts and who it is (the page works without them).
  const draftList = (status: 'pending' | 'decided') =>
    api
      .POST('/v1/queries/ai_teammate.draft_list', {
        body: { workspaceId, status, limit: status === 'pending' ? 100 : DECIDED },
      })
      .then((r): TeammateDraft[] => r.data?.items ?? [])
      .catch((): TeammateDraft[] => []);
  const [drafts, decidedDrafts, teammate] = await Promise.all([
    draftList('pending'),
    draftList('decided'),
    api
      .POST('/v1/queries/ai_teammate.get', { body: { workspaceId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
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
  const manages = can(got.workspace.permissions, 'workflows.manage');
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
        description={
          teammate?.teammate
            ? `Approvals collect everything waiting for a yes, from workflows and from ${teammate.teammate.name}.`
            : 'Approvals: steps that wait for a person before they text or email. Owners and admins see every one; named people see theirs.'
        }
      />
      <WorkflowsSubnav workspaceId={workspaceId} />
      <ApprovalsBoard
        workspaceId={workspaceId}
        waiting={pending.filter((a) => a.canDecide)}
        decided={decided}
        allowPrices={profile ? profile.profile.allowPrices : null}
        serverNow={Date.now()}
        drafts={drafts}
        decidedDrafts={decidedDrafts}
        teammateName={teammate?.teammate?.name ?? null}
        progress={teammate?.progress ?? null}
        timezone={got.workspace.timezone}
        initialFilter={initialFilter}
      />
    </>
  );
}
