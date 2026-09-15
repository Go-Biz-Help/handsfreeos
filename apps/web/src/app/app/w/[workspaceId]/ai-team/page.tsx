import type { Metadata } from 'next';
import { TeammateTab } from '@/components/ai-team/teammate-tab';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate' };

/**
 * The Teammate tab: the preset picker until the business has a teammate, then the builder. Everyone reads
 * it; owners and admins (ai_team.manage) change it.
 */
export default async function AiTeamPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, got] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
  ]);
  const { workspace } = unwrapPage(ws);
  return (
    <TeammateTab
      workspaceId={workspaceId}
      workspaceName={workspace.name}
      data={teammateGetOf(unwrapPage(got))}
    />
  );
}
