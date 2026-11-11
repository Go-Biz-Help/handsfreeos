import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ContractorSettingsPage } from '@/addons/contractor/settings-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Contractor settings' };

/**
 * Contractor Operations' settings: the trades the business does, a new project's phases, a new visit's checklist, its
 * crews, and how it estimates (its lowest margin, starting markup and labor's hourly price and cost). Owners and
 * admins.
 */
export default async function ContractorSettingsRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.manage', async () => {
    const { api } = await apiServer();
    const [overview, crews] = await Promise.all([
      api.POST('/v1/queries/contractor.overview', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/contractor.crew.list', { body: { workspaceId, includeArchived: true } })
        .then(unwrapPage),
    ]);
    return (
      <ContractorSettingsPage
        workspaceId={workspaceId}
        settings={overview.settings}
        crews={crews.crews}
        people={overview.people}
        estimating={overview.estimating}
        mayApprove={overview.may.approve}
      />
    );
  });
}
