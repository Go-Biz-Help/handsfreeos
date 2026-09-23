import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { Documents } from '@/components/knowledge/documents';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Knowledge documents' };

/** PDFs and text files whose text the AI can use once it's checked and published. */
export default async function KnowledgeDocumentsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_item.list', {
      body: {
        workspaceId,
        kind: ['document'],
        status: ['draft', 'published', 'archived'],
        limit: 100,
      },
    }),
  ]);
  const { workspace } = unwrapPage(ws);
  return (
    <Documents
      workspaceId={workspaceId}
      canManage={can(workspace.permissions, 'knowledge.manage')}
      items={unwrapPage(list).items}
    />
  );
}
