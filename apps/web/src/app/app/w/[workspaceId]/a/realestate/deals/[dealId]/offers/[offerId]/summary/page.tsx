import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { OfferSummaryPage } from '@/addons/realestate/offers-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Offer summary' };

/** An offer's one-page summary, as the clients see it in their portal, to print or share. */
export default async function RealestateOfferSummaryPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string; offerId: string }>;
}) {
  const { workspaceId, dealId, offerId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, offers] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.offers', inDeal).then(unwrapPage),
    ]);
    const offer = offers.offers.find((o) => o.id === offerId);
    // A listing's seller sees its offers side by side instead of one buyer's summary.
    if (!offer || deal.deal.side === 'listing') notFound();
    return (
      <OfferSummaryPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        businessName={got.workspace.name}
        offer={offer}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
