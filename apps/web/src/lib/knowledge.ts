import { can } from '@hfos/core';
import type { ApiClient } from '@hfos/api-client';
import type { ComponentProps } from 'react';
import type { CurrentItem } from '@/components/knowledge/suggestion-card';
import type { WebsiteScan } from '@/components/knowledge/website-scan';
import { unwrapPage } from '@/lib/api/server';

/**
 * The business's website, its newest scan (live while it reads), and that scan's suggestions page by page: for
 * Knowledge → Website and the setup wizard's AI step.
 */
export async function loadWebsiteScan(
  api: ApiClient,
  workspaceId: string,
): Promise<ComponentProps<typeof WebsiteScan>> {
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
  return {
    workspaceId,
    canManage: can(workspace.permissions, 'knowledge.manage'),
    source,
    scan,
    suggestions,
    current: Object.fromEntries(current.filter((c): c is readonly [string, CurrentItem] => !!c)),
  };
}
