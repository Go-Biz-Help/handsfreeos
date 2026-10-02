import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ListingOffersPage } from '@/addons/realestate/listing-offers-page';
import { OffersPage } from '@/addons/realestate/offers-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Offers' };

/**
 * A deal's offers and CMAs, and making an offer (`?start=<homeId>` on a buyer deal). On a listing, its offers side by
 * side with what the seller would take home from each, and adding one (`?start=`).
 */
export default async function RealestateOffersPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const deal = await api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage);
    const side = deal.deal.side;
    if (side === 'listing') {
      const [got, compare, offers, documents] = await Promise.all([
        api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
        api.POST('/v1/queries/realestate.offers.compare', inDeal).then(unwrapPage),
        api.POST('/v1/queries/realestate.offers', inDeal).then(unwrapPage),
        api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
      ]);
      return (
        <ListingOffersPage
          workspaceId={workspaceId}
          dealId={dealId}
          dealName={deal.deal.name}
          timeZone={got.workspace.timezone}
          compare={compare}
          offers={offers.offers}
          documents={documents.documents}
          sellers={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
          live={!deal.deal.outcome && !deal.deal.archived}
        />
      );
    }
    const [got, offers, cmas, homes, documents] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
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
        side={side}
      />
    );
  });
}
