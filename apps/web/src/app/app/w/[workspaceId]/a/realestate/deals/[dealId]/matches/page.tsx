import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { MatchesPage } from '@/addons/realestate/matches-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'New matches' };

/** A buyer's new matches from the MLS, and their saved search (round five). The Home card links here. */
export default async function RealestateMatchesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const deal = await api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage);
    // A saved search is a buyer's; a listing has none.
    if (deal.deal.side !== 'buyer') notFound();
    const list = await api.POST('/v1/queries/realestate.matches', inDeal).then(unwrapPage);
    return (
      <MatchesPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        agentName={deal.team.find((t) => t.main)?.name ?? null}
        list={list}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
