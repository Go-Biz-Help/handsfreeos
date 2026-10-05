import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { DescriptionPage } from '@/addons/realestate/description-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Description' };

/** A listing's description: the AI's draft, both fair housing checks, the agent's edits, the seller's sign-off. */
export default async function RealestateDescriptionPage({
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
    const { listing } = await api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage);
    return (
      <DescriptionPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        listing={listing}
        sellers={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
