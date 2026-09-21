import type { Metadata } from 'next';
import { ConversationView } from '@/components/inbox/conversation-view';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Inbox' };

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; conversationId: string }>;
  // The list's own filters ride along on links between conversations; only `lanes` is read here.
  searchParams: Promise<{ lanes?: string; box?: string; status?: string; q?: string }>;
}) {
  const { workspaceId, conversationId } = await params;
  // "All lines": every lane of this customer woven into one timeline, and nothing sendable from it (0089).
  const allLanes = (await searchParams).lanes === 'all';
  const { api } = await apiServer();
  const [data, thread, workspace, tags, pipelines] = await Promise.all([
    unwrapPage(
      await api.POST('/v1/queries/conversation.get', { body: { workspaceId, conversationId } }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/conversation.thread', {
        body: { workspaceId, conversationId, limit: 30, ...(allLanes ? { allLanes } : {}) },
      }),
    ),
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/pipeline.list', { body: { workspaceId } })),
  ]);
  return (
    <ConversationView
      key={`${conversationId}:${allLanes}`}
      data={data}
      thread={thread}
      allLanes={allLanes}
      tags={tags.tags}
      pipelines={pipelines.pipelines}
      businessName={workspace.workspace.name}
    />
  );
}
