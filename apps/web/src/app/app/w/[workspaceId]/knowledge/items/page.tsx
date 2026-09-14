import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { ItemList, type ItemFilters } from '@/components/knowledge/item-list';
import { apiServer, unwrapPage } from '@/lib/api/server';
import type { KnowledgeItemKind, KnowledgeItemListBody } from '@/lib/api/types';

export const metadata: Metadata = { title: 'Knowledge items' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
const KINDS: readonly KnowledgeItemKind[] = ['faq', 'article', 'fact', 'document'];
const STATUSES = ['published', 'draft', 'archived'] as const;

/** FAQs, articles, facts and documents: search (with the matching passages), kind, tag and status. */
export default async function KnowledgeItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const kind = one(sp.kind);
  const status = one(sp.status);
  const filters: ItemFilters = {
    q: one(sp.q).trim().slice(0, 200),
    kind: (KINDS as readonly string[]).includes(kind) ? (kind as KnowledgeItemKind) : null,
    tag: one(sp.tag).trim().slice(0, 40) || null,
    status: (STATUSES as readonly string[]).includes(status)
      ? (status as (typeof STATUSES)[number])
      : null,
  };
  const body: KnowledgeItemListBody = {
    workspaceId,
    limit: 50,
    ...(filters.q ? { search: filters.q } : {}),
    ...(filters.kind ? { kind: [filters.kind] } : {}),
    ...(filters.tag ? { tags: [filters.tag] } : {}),
    ...(filters.status ? { status: [filters.status] } : {}),
  };
  const filtered = !!(filters.q || filters.kind || filters.tag || filters.status);
  const { api } = await apiServer();
  const [ws, list, all, search] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge_item.list', { body }),
    // The tags to filter by come from the whole knowledge base, whatever is filtered now.
    filtered
      ? api.POST('/v1/queries/knowledge_item.list', { body: { workspaceId, limit: 100 } })
      : null,
    // The matching passages for a search (published and draft items).
    filters.q
      ? api.POST('/v1/queries/knowledge.search', {
          body: {
            workspaceId,
            query: filters.q,
            limit: 20,
            includeDrafts: true,
            ...(filters.kind ? { kinds: [filters.kind] } : {}),
          },
        })
      : null,
  ]);
  const { workspace } = unwrapPage(ws);
  const page = unwrapPage(list);
  const tagSource = all ? unwrapPage(all).items : page.items;
  const freq = new Map<string, number>();
  for (const i of tagSource) for (const t of i.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
  const tags = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([t]) => t);
  const snippets = Object.fromEntries(
    (search ? unwrapPage(search).matches : []).map((m) => [m.id, m.snippet]),
  );
  return (
    <ItemList
      key={JSON.stringify(filters)}
      workspaceId={workspaceId}
      canManage={hasWorkspacePermission(workspace.role, 'knowledge.manage')}
      filters={filters}
      page={page}
      tags={filters.tag && !tags.includes(filters.tag) ? [filters.tag, ...tags] : tags}
      snippets={snippets}
    />
  );
}
