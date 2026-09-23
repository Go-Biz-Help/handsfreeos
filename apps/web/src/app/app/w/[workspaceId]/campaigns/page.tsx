import { can } from '@hfos/core';
import { Plus } from 'lucide-react';
import type { Metadata } from 'next';
import { CampaignList } from '@/components/campaigns/campaign-list';
import { PageHeader } from '@/components/shell/page-header';
import { ButtonLink } from '@/components/ui/button';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Campaigns' };

/** Everyone can see the campaigns; owners and admins make and approve them. */
export default async function CampaignsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const [got, list] = await Promise.all([
    api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
    api.POST('/v1/queries/campaign.list', { body: { workspaceId } }).then(unwrapPage),
  ]);
  const canManage = can(got.workspace.permissions, 'workflows.manage');
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="One text to a list of customers, written for each of them by the AI and read by you before anything goes."
        actions={
          canManage ? (
            <ButtonLink
              href={`/app/w/${workspaceId}/campaigns/new`}
              variant="primary"
              data-testid="campaign-new-link"
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New campaign
            </ButtonLink>
          ) : null
        }
      />
      <CampaignList workspaceId={workspaceId} items={list.items} />
    </>
  );
}
