import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { KnowledgeOverview, type KindCount } from '@/components/knowledge/overview';
import { apiServer, unwrapPage } from '@/lib/api/server';
import type { KnowledgeItemKind } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Knowledge' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

/** The business profile and tone of voice, what the knowledge base holds, suggestions waiting, and Try it. */
export default async function KnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const ask = one((await searchParams).ask)
    .trim()
    .slice(0, 500);
  const { api } = await apiServer();
  const [ws, profile, items, waiting] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge.profile', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_item.list', { body: { workspaceId, limit: 100 } }),
    api.POST('/v1/queries/knowledge_suggestion.list', {
      body: { workspaceId, status: 'pending', limit: 100 },
    }),
  ]);
  const { workspace } = unwrapPage(ws);
  const list = unwrapPage(items);
  const suggestions = unwrapPage(waiting);
  const kinds: KnowledgeItemKind[] = ['faq', 'article', 'fact', 'document'];
  const counts: KindCount[] = kinds.map((kind) => {
    const of = list.items.filter((i) => i.kind === kind);
    return {
      kind,
      published: of.filter((i) => i.status === 'published').length,
      drafts: of.filter((i) => i.status === 'draft').length,
      newest: of[0]?.title ?? null,
    };
  });
  const samples = list.items
    .filter((i) => i.kind === 'faq' && i.status === 'published')
    .slice(0, 3)
    .map((i) => i.title);
  return (
    <KnowledgeOverview
      workspaceId={workspaceId}
      canManage={can(workspace.permissions, 'knowledge.manage')}
      profile={unwrapPage(profile)}
      counts={counts}
      countsCapped={!!list.nextCursor}
      suggestions={suggestions.items}
      moreSuggestions={!!suggestions.nextCursor}
      samples={samples}
      ask={ask}
    />
  );
}
