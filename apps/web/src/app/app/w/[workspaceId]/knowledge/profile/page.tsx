import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { ProfileForm } from '@/components/knowledge/profile-form';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Business profile' };

/** The business profile and tone of voice the AI writes from. Owners and admins edit; members read. */
export default async function KnowledgeProfilePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [ws, profile] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }),
    api.POST('/v1/queries/knowledge.profile', { body: { workspaceId } }),
  ]);
  const { workspace } = unwrapPage(ws);
  return (
    <ProfileForm
      workspaceId={workspaceId}
      canManage={can(workspace.permissions, 'knowledge.manage')}
      profile={unwrapPage(profile)}
    />
  );
}
