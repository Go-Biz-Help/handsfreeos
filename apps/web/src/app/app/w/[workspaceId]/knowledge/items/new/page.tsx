import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ItemEditor } from '@/components/knowledge/item-editor';
import { getWorkspace } from '@/lib/api/server';

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
  const { workspace } = await getWorkspace(workspaceId);
  if (!can(workspace.permissions, 'knowledge.manage'))
    redirect(`/app/w/${workspaceId}/knowledge/items`);
  return <ItemEditor workspaceId={workspaceId} canManage item={null} newKind={kind} />;
}
