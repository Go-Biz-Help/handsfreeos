import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ContractorSettingsPage } from '@/addons/contractor/settings-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Contractor settings' };

/**
 * Contractor Operations' settings: the trades the business does, a new project's phases, and how it estimates (its
 * lowest margin, starting markup and labor's hourly price and cost). Owners and admins.
 */
export default async function ContractorSettingsRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.manage', async () => {
    const { api } = await apiServer();
    const overview = await api
      .POST('/v1/queries/contractor.overview', { body: { workspaceId } })
      .then(unwrapPage);
    return (
      <ContractorSettingsPage
        workspaceId={workspaceId}
        settings={overview.settings}
        estimating={overview.estimating}
        mayApprove={overview.may.approve}
      />
    );
  });
}
