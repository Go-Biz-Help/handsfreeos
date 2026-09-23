import type { Metadata } from 'next';
import { RoadmapBoard } from '@/components/ideas/roadmap-board';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Roadmap' };

export default async function RoadmapPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [roadmap, areas] = await Promise.all([
    api.POST('/v1/queries/idea.roadmap', { body: {} }).then(unwrapPage),
    api.POST('/v1/queries/idea.areas', { body: {} }).then(unwrapPage),
  ]);
  return <RoadmapBoard workspaceId={workspaceId} roadmap={roadmap} areas={areas.areas} />;
}
