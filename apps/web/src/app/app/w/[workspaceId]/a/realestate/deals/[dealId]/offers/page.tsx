import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { OffersPage } from '@/addons/realestate/offers-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Offers' };

/** A buyer deal's offers and CMAs, and making an offer (`?start=<homeId>`). */
export default async function RealestateOffersPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, offers, cmas, homes, documents] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.offers', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.cmas', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.homes', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
    ]);
    return (
      <OffersPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        offers={offers.offers}
        cmas={cmas.cmas}
        homes={homes.homes}
        documents={documents.documents}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
