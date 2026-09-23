import type { Metadata } from 'next';
import { PipelineBoard } from '@/components/pipeline/board';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Pipeline' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

export default async function PipelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const pipelineId = /^[0-9a-f-]{36}$/.test(one(sp.pipeline)) ? one(sp.pipeline) : undefined;
  const view = one(sp.view) === 'list' ? 'list' : one(sp.view) === 'board' ? 'board' : null;
  const { api, userId } = await apiServer();
  const [got, board, pipelines, members, tags] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(
      await api.POST('/v1/queries/lead.board', {
        body: { workspaceId, ...(pipelineId ? { pipelineId } : {}) },
      }),
    ),
    unwrapPage(await api.POST('/v1/queries/pipeline.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
  ]);
  return (
    <PipelineBoard
      workspaceId={workspaceId}
      initial={board}
      pipelines={pipelines.pipelines}
      members={assigneeOptions(members)}
      tags={tags.tags}
      permissions={got.workspace.permissions}
      myUserId={userId}
      initialView={view}
    />
  );
}
