import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { FinancingPage } from '@/addons/realestate/financing-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Financing' };

/** A buyer deal's loan, step by step, each done with its proof; and the lender. */
export default async function RealestateFinancingPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [deal, financing, documents, files] = await Promise.all([
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.financing', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
    ]);
    return (
      <FinancingPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        address={deal.property?.address ?? null}
        financing={financing}
        documents={documents.documents}
        files={files.files.map((f) => ({ id: f.id, name: f.name }))}
        live={!deal.deal.outcome && !deal.deal.archived}
        side={deal.deal.side}
      />
    );
  });
}
