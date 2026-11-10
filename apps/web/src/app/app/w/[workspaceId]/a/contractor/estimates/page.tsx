import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { EstimatesHome } from '@/addons/contractor/estimates-home';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Estimates' };

/**
 * The estimates built in Contractor Operations, newest first, or only the ones waiting for an owner's or admin's OK
 * (`?waiting=1`, where the Jobs page's notice and the alert point). For people who may see job costs.
 */
export default async function ContractorEstimatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const waiting = (await searchParams).waiting === '1';
  return addonPage(workspaceId, 'contractor', 'contractor.costs', async () => {
    const { api } = await apiServer();
    const [got, list] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/contractor.estimate.list', {
          body: { workspaceId, waitingOk: waiting },
        })
        .then(unwrapPage),
    ]);
    return (
      <EstimatesHome
        workspaceId={workspaceId}
        list={list}
        waiting={waiting}
        timeZone={got.workspace.timezone}
      />
    );
  });
}
