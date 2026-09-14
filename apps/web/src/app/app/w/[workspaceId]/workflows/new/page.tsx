import { hasWorkspacePermission, RECIPE_KEYS, type RecipeKey } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { NewWorkflow } from '@/components/workflows/new-workflow';
import { apiServer, unwrap, unwrapPage } from '@/lib/api/server';
import type { WorkflowProposal } from '@/lib/api/types';

const ID = /^[0-9a-f-]{36}$/i;

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
  // "Add automation" on a calendar passes the calendar to fill in (`?calendar=<id>`).
  const calendar = typeof query.calendar === 'string' ? query.calendar : null;
  // The Assistant's draft of a new workflow (`?proposal=<id>&name=<words_joined_by_underscores>`).
  let proposal: WorkflowProposal | null = null;
  if (typeof query.proposal === 'string' && ID.test(query.proposal)) {
    try {
      proposal = unwrap(
        await api.POST('/v1/queries/workflow.proposal_get', {
          body: { workspaceId, proposalId: query.proposal },
        }),
      ).proposal;
    } catch {
      proposal = null;
    }
  }
  // A change to a workflow that exists opens in that workflow's Describe mode instead.
  if (proposal?.workflowId)
    redirect(
      `/app/w/${workspaceId}/workflows/${proposal.workflowId}?mode=describe&proposal=${proposal.id}`,
    );
  const name =
    typeof query.name === 'string' ? query.name.replace(/_/g, ' ').trim().slice(0, 120) : '';
  return (
    <NewWorkflow
      workspaceId={workspaceId}
      businessName={got.workspace.name}
      catalogs={catalogs.catalogs}
      templates={list.items.filter((w) => w.source.kind === 'template' && w.status === 'draft')}
      initialRecipe={initialRecipe}
      initialCalendarId={calendar}
      initialProposal={proposal}
      initialName={name || null}
    />
  );
}
