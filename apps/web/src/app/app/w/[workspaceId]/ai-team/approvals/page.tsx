import type { Metadata } from 'next';
import { TeammateApprovalsTab } from '@/components/ai-team/approvals-tab';
import type { TeammateDraft } from '@/lib/ai-team/inbox-types';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate approvals' };

/** How many decided drafts the Decided view lists. */
const DECIDED = 30;

/**
 * The Approvals tab: the teammate's funnel suggestions and drafts waiting for a yes, and the drafts decided lately,
 * without leaving the AI teammate area. Workflows › Approvals lists them too, beside workflow approvals.
 */
export default async function AiTeamApprovalsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const draftList = (status: 'pending' | 'decided') =>
    api
      .POST('/v1/queries/ai_teammate.draft_list', {
        body: { workspaceId, status, limit: status === 'pending' ? 100 : DECIDED },
      })
      .then((r): TeammateDraft[] => r.data?.items ?? [])
      .catch((): TeammateDraft[] => []);
  const [got, drafts, decidedDrafts, suggestions] = await Promise.all([
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    draftList('pending'),
    draftList('decided'),
    api
      .POST('/v1/queries/funnel.suggestions', { body: { workspaceId } })
      .then((r) => r.data?.suggestions ?? [])
      .catch(() => []),
  ]);
  return (
    <TeammateApprovalsTab
      workspaceId={workspaceId}
      data={teammateGetOf(unwrapPage(got))}
      drafts={drafts}
      decidedDrafts={decidedDrafts}
      suggestions={suggestions}
      serverNow={Date.now()}
    />
  );
}
