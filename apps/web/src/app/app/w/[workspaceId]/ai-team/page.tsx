import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { TeammateTab } from '@/components/ai-team/teammate-tab';
import { teammateGetOf } from '@/lib/ai-team/types';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI teammate' };

/**
 * The Teammate tab: until the business has a teammate, owners and admins (ai_team.manage) go to quick setup, and
 * "Set it up myself" (`?myself=1`) shows the preset picker here; then the builder. Everyone reads it; owners and
 * admins change it.
 */
export default async function AiTeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, got, query] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/ai_teammate.get', { body: { workspaceId } }),
    searchParams,
  ]);
  const { workspace } = unwrapPage(ws);
  const data = teammateGetOf(unwrapPage(got));
  const setup = `/app/w/${workspaceId}/ai-team/setup`;
  const myself = query['myself'] === '1';
  if (!data.teammate && data.canManage && !myself) redirect(setup);
  return (
    <TeammateTab
      workspaceId={workspaceId}
      workspaceName={workspace.name}
      data={data}
      quickSetupHref={myself ? setup : null}
    />
  );
}
