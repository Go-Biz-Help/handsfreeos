import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { EstimateBuilder } from '@/addons/contractor/estimate-builder';
import { unwrapPage } from '@/lib/api/server';
import { loadEditorCatalogs, loadMoneyShell } from '../../../../money/load';

export const metadata: Metadata = { title: 'New estimate' };

/**
 * A new estimate in the builder, for a job when one is named (`?jobId=`): its customer is who the estimate is for.
 * With `&draftId=` it opens from the AI's draft for that job, every line there to check. Nothing is kept until Save.
 * For people who may see job costs.
 */
export default async function ContractorNewEstimatePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const idOf = (v: string | string[] | undefined) => {
    const wanted = Array.isArray(v) ? v[0] : v;
    return wanted && /^[0-9a-f-]{36}$/i.test(wanted) ? wanted : undefined;
  };
  const jobId = idOf(sp.jobId);
  // A draft is a job's: without the job there's nothing to open it for.
  const draftId = jobId ? idOf(sp.draftId) : undefined;
  return addonPage(workspaceId, 'contractor', 'contractor.costs', async () => {
    const shell = await loadMoneyShell(workspaceId);
    const [data, catalogs, costs] = await Promise.all([
      shell.api
        .POST('/v1/queries/contractor.estimate.get', {
          body: { workspaceId, ...(jobId ? { jobId } : {}), ...(draftId ? { draftId } : {}) },
        })
        .then(unwrapPage),
      loadEditorCatalogs(shell.api, workspaceId),
      shell.api
        .POST('/v1/queries/contractor.item_cost.list', { body: { workspaceId } })
        .then(unwrapPage),
    ]);
    return (
      <EstimateBuilder
        workspaceId={workspaceId}
        data={data}
        settings={shell.settings}
        products={catalogs.products}
        itemCosts={costs.items}
        timeZone={shell.timeZone}
        nextNumber={shell.nextEstimateNumber}
      />
    );
  });
}
