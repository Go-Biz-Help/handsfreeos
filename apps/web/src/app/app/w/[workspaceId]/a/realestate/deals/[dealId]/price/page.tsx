import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { PricePage } from '@/addons/realestate/price-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Price' };

/** A listing's price: a change waiting on the seller's sign-off, and every change since it was listed. */
export default async function RealestatePricePage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
    ]);
    if (deal.deal.side !== 'listing') notFound();
    const [{ listing }, prices, terms] = await Promise.all([
      api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.listing.prices', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/realestate.term.history', {
          body: { workspaceId, dealId, key: 'list_price' },
        })
        .then(unwrapPage),
    ]);
    return (
      <PricePage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        listing={listing}
        prices={prices}
        listPrices={terms.entries}
        sellers={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
