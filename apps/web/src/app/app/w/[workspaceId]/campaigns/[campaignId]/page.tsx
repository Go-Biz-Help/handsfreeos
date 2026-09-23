import { hasWorkspacePermission } from '@hfos/core';
import type { Metadata } from 'next';
import { CampaignView } from '@/components/campaigns/campaign-view';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Campaign' };

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ workspaceId: string; campaignId: string }>;
}) {
  const { workspaceId, campaignId } = await params;
  const { api } = await apiServer();
  const [got, data] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/campaign.get', { body: { workspaceId, campaignId } }).then(unwrapPage),
  ]);
  return (
    <>
      <PageHeader title={data.campaign.name} />
      <CampaignView
        workspaceId={workspaceId}
        data={data}
        canManage={hasWorkspacePermission(got.workspace.role, 'workflows.manage')}
      />
    </>
  );
}
