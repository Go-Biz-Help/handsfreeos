import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ItemCostsPage } from '@/addons/contractor/item-costs-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Item costs' };

/**
 * What each item on the business's price list costs it, so an estimate knows its profit. The price list itself is
 * core's (Settings → Products). For people who may see job costs.
 */
export default async function ContractorItemCostsRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return addonPage(workspaceId, 'contractor', 'contractor.costs', async () => {
    const { api } = await apiServer();
    const [got, list, overview] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/contractor.item_cost.list', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/contractor.overview', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <ItemCostsPage
        workspaceId={workspaceId}
        items={list.items}
        minMarginBp={overview.estimating?.minMarginBp ?? 0}
        canEditProducts={got.workspace.permissions.includes('money.manage')}
      />
    );
  });
}
