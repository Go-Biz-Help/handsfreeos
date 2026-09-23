import { can } from '@hfos/core';
import type { Metadata } from 'next';
import type { CurrentItem } from '@/components/knowledge/suggestion-card';
import { WebsiteScan } from '@/components/knowledge/website-scan';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Website scan' };

/** The business's website, its newest scan (live while it reads), and that scan's suggestions page by page. */
export default async function KnowledgeWebsitePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, got] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_scan.get', { body: { workspaceId } }),
  ]);
  const { workspace } = unwrapPage(ws);
  const { source, scan } = unwrapPage(got);
  const suggestions = scan
    ? unwrapPage(
        await api.POST('/v1/queries/knowledge_suggestion.list', {
          body: { workspaceId, scanId: scan.id, status: 'pending', limit: 100 },
        }),
      ).items
    : [];
  const targets = [...new Set(suggestions.flatMap((s) => (s.itemId ? [s.itemId] : [])))];
  const current = await Promise.all(
    targets.map(async (itemId) => {
      const item = (
        await api.POST('/v1/queries/knowledge_item.get', { body: { workspaceId, itemId } })
      ).data?.item;
      return item
        ? ([itemId, { id: item.id, kind: item.kind, title: item.title, body: item.body }] as const)
        : null;
    }),
  );
  return (
    <WebsiteScan
      workspaceId={workspaceId}
      canManage={can(workspace.permissions, 'knowledge.manage')}
      source={source}
      scan={scan}
      suggestions={suggestions}
      current={Object.fromEntries(current.filter((c): c is readonly [string, CurrentItem] => !!c))}
    />
  );
}
