import type { Metadata } from 'next';
import { FunnelsTab } from '@/components/funnels/funnels-tab';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Funnels' };

/** The Funnels tab: the paths the AI teammate takes people through (HANDSFREEOS_TEAMMATE_FUNNELS_IMPLEMENTATION_PLAN.md). */
export default async function AiTeamFunnelsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, list, suggestions] = await Promise.all([
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    api.POST('/v1/queries/funnel.list', { body: { workspaceId } }),
    api.POST('/v1/queries/funnel.suggestions', { body: { workspaceId } }),
  ]);
  return (
    <FunnelsTab
      workspaceId={workspaceId}
      data={teammateGetOf(unwrapPage(got))}
      list={unwrapPage(list)}
      suggestions={unwrapPage(suggestions).suggestions.length}
    />
  );
}
