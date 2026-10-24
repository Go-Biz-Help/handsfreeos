import type { Metadata } from 'next';
import { NewFunnel } from '@/components/funnels/new-funnel';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'New funnel' };

/** New funnel: how it should go (the teammate drafts it), its name and its pipeline. The steps take it from there. */
export default async function NewFunnelPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [pipelines, funnels, teammate] = await Promise.all([
    api.POST('/v1/queries/pipeline.list', { body: { workspaceId } }),
    api.POST('/v1/queries/funnel.list', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
  ]);
  return (
    <NewFunnel
      workspaceId={workspaceId}
      teammateName={unwrapPage(teammate).teammate?.name ?? 'The AI'}
      pipelines={unwrapPage(pipelines).pipelines}
      takenPipelineIds={unwrapPage(funnels).funnels.map((f) => f.pipelineId)}
    />
  );
}
