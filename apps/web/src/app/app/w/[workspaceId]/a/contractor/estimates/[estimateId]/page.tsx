import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { EstimateBuilder, SentEstimate } from '@/addons/contractor/estimate-builder';
import { ApiError, unwrapPage } from '@/lib/api/server';
import { loadEditorCatalogs, loadMoneyShell } from '../../../../money/load';

export const metadata: Metadata = { title: 'Estimate' };

/**
 * One estimate in the builder: its lines with what each costs, each option's profit and margin, and its OK when it's
 * under the lowest margin. Once it has gone out it can't change, so the page is its costs and the way to its own
 * page. For people who may see job costs. An estimate that wasn't built here opens on its own page in Money.
 */
export default async function ContractorEstimatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; estimateId: string }>;
}) {
  const { workspaceId, estimateId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.costs', async () => {
    const shell = await loadMoneyShell(workspaceId);
    const got = await shell.api.POST('/v1/queries/contractor.estimate.get', {
      body: { workspaceId, estimateId },
    });
    let data;
    try {
      data = unwrapPage(got);
    } catch (e) {
      if (e instanceof ApiError && e.rule === 'contractor_estimate_not_here')
        redirect(`/app/w/${workspaceId}/money/estimates/${estimateId}`);
      throw e;
    }
    if (data.estimate && data.estimate.status !== 'draft')
      return <SentEstimate workspaceId={workspaceId} data={data} />;
    const [catalogs, costs] = await Promise.all([
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
