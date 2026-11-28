import { can, lookOf } from '@hfos/core';
import type { Metadata } from 'next';
import { CampaignView } from '@/components/campaigns/campaign-view';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, getWorkspace, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Campaign' };

const websiteOf = (settings: unknown): string | null => {
  const w = (settings as Record<string, unknown> | null)?.['website'];
  return typeof w === 'string' && /^https?:\/\//.test(w) ? w : null;
};

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ workspaceId: string; campaignId: string }>;
}) {
  const { workspaceId, campaignId } = await params;
  const { api } = await apiServer();
  const [got, data] = await Promise.all([
    getWorkspace(workspaceId),
    api.POST('/v1/queries/campaign.get', { body: { workspaceId, campaignId } }).then(unwrapPage),
  ]);
  return (
    <>
      <PageHeader title={data.campaign.name} />
      <CampaignView
        workspaceId={workspaceId}
        data={data}
        canManage={can(got.workspace.permissions, 'workflows.manage')}
        brand={{
          name: got.workspace.name,
          look: lookOf(got.workspace.settings),
          website: websiteOf(got.workspace.settings),
        }}
      />
    </>
  );
}
