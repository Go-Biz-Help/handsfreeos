import { hasWorkspacePermission, RECIPE_KEYS, type RecipeKey } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NewWorkflow } from '@/components/workflows/new-workflow';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'New workflow' };

/** "How do you want to start?" Owners and admins only. */
export default async function NewWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!hasWorkspacePermission(got.workspace.role, 'workflows.manage')) notFound();
  const [catalogs, list] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workflow.catalogs', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workflow.list', { body: { workspaceId } })),
  ]);
  const recipe = typeof query.recipe === 'string' ? query.recipe : null;
  const initialRecipe = (RECIPE_KEYS as readonly string[]).includes(recipe ?? '')
    ? (recipe as RecipeKey)
    : null;
  return (
    <NewWorkflow
      workspaceId={workspaceId}
      businessName={got.workspace.name}
      catalogs={catalogs.catalogs}
      templates={list.items.filter((w) => w.source.kind === 'template' && w.status === 'draft')}
      initialRecipe={initialRecipe}
    />
  );
}
