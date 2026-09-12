import type { Metadata } from 'next';
import { ConversationView } from '@/components/inbox/conversation-view';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Inbox' };

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ workspaceId: string; conversationId: string }>;
}) {
  const { workspaceId, conversationId } = await params;
  const { api } = await apiServer();
  const [data, thread, workspace, tags, pipelines] = await Promise.all([
    unwrapPage(
      await api.POST('/v1/queries/conversation.get', { body: { workspaceId, conversationId } }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/conversation.thread', {
        body: { workspaceId, conversationId, limit: 30 },
      }),
    ),
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/pipeline.list', { body: { workspaceId } })),
  ]);
  return (
    <ConversationView
      key={conversationId}
      data={data}
      thread={thread}
      tags={tags.tags}
      pipelines={pipelines.pipelines}
      businessName={workspace.workspace.name}
    />
  );
}
