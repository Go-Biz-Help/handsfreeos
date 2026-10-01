import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { OfferPage } from '@/addons/realestate/offers-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Offer' };

/** One offer: its versions side by side, the clock, and recording the answer. Where the offer's alerts open. */
export default async function RealestateOfferPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string; offerId: string }>;
}) {
  const { workspaceId, dealId, offerId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, offers, documents] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.offers', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
    ]);
    const offer = offers.offers.find((o) => o.id === offerId);
    if (!offer) notFound();
    return (
      <OfferPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        offer={offer}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        documents={documents.documents}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
