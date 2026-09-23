import type { Metadata } from 'next';
import { IdeaView } from '@/components/ideas/idea-view';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Idea' };

export default async function IdeaPage({
  params,
}: {
  params: Promise<{ workspaceId: string; ideaId: string }>;
}) {
  const { workspaceId, ideaId } = await params;
  const { api } = await apiServer();
  const [data, areas] = await Promise.all([
    api.POST('/v1/queries/idea.get', { body: { ideaId } }).then(unwrapPage),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrapPage),
  ]);
  return <IdeaView key={ideaId} workspaceId={workspaceId} data={data} areas={areas.areas} />;
}
