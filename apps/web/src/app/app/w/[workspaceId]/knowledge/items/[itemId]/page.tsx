import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { ItemEditor } from '@/components/knowledge/item-editor';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Knowledge item' };

/** One FAQ, article, fact or document: its text, tags, status, where it came from and when it was used. */
export default async function KnowledgeItemPage({
  params,
}: {
  params: Promise<{ workspaceId: string; itemId: string }>;
}) {
  const { workspaceId, itemId } = await params;
  const { api } = await apiServer();
  const [ws, got] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_item.get', { body: { workspaceId, itemId } }),
  ]);
  const { workspace } = unwrapPage(ws);
  const { item } = unwrapPage(got);
  return (
    <ItemEditor
      key={`${item.id}:${item.updatedAt}`}
      workspaceId={workspaceId}
      canManage={hasWorkspacePermission(workspace.role, 'knowledge.manage')}
      item={item}
      newKind={null}
    />
  );
}
