import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { NetSheetPage } from '@/addons/realestate/net-sheet-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Seller’s estimate' };

/** A listing's seller's estimate: the agent's figures and what the seller would take home from each offer. */
export default async function RealestateNetSheetPage({
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
    const [compare, { listing }] = await Promise.all([
      api.POST('/v1/queries/realestate.offers.compare', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage),
    ]);
    return (
      <NetSheetPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        compare={compare}
        listPriceCents={listing.listPriceCents}
        sellers={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
