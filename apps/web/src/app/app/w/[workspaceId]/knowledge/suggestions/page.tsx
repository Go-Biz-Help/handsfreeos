import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import type { CurrentItem } from '@/components/knowledge/suggestion-card';
import { SuggestionsBoard, type ReasonFilter } from '@/components/knowledge/suggestions-board';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Knowledge suggestions' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

/** Suggestions waiting for a person: from website scans, questions the AI couldn't answer, and agency packs. */
export default async function KnowledgeSuggestionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const reason = one((await searchParams).reason);
  const { api } = await apiServer();
  const [ws, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_suggestion.list', {
      body: { workspaceId, status: 'pending', limit: 100 },
    }),
  ]);
  const { workspace } = unwrapPage(ws);
  const pending = unwrapPage(list);
  // The items rescans propose to change, as they read now, to show what would change.
  const targets = [...new Set(pending.items.flatMap((s) => (s.itemId ? [s.itemId] : [])))];
  const current = await Promise.all(
    targets.map(async (itemId) => {
      const got = await api.POST('/v1/queries/knowledge_item.get', {
        body: { workspaceId, itemId },
      });
      const item = got.data?.item;
      return item
        ? ([itemId, { id: item.id, kind: item.kind, title: item.title, body: item.body }] as const)
        : null;
    }),
  );
  const filter: ReasonFilter =
    reason === 'scan' || reason === 'gap' || reason === 'pack' ? reason : 'all';
  return (
    <SuggestionsBoard
      workspaceId={workspaceId}
      canManage={hasWorkspacePermission(workspace.role, 'knowledge.manage')}
      items={pending.items}
      more={!!pending.nextCursor}
      current={Object.fromEntries(current.filter((c): c is readonly [string, CurrentItem] => !!c))}
      initialFilter={filter}
    />
  );
}
