import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ItemEditor } from '@/components/knowledge/item-editor';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'New knowledge item' };

const one = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? '') : (v ?? '');

/** A new FAQ, article or fact (owners and admins; members go back to the list). */
export default async function NewKnowledgeItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const asked = one((await searchParams).kind);
  const kind = asked === 'article' || asked === 'fact' ? asked : 'faq';
  const { api } = await apiServer();
  const { workspace } = unwrapPage(
    await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
  );
  if (!hasWorkspacePermission(workspace.role, 'knowledge.manage'))
    redirect(`/app/w/${workspaceId}/knowledge/items`);
  return <ItemEditor workspaceId={workspaceId} canManage item={null} newKind={kind} />;
}
