import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { HomesPage } from '@/addons/realestate/homes-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Homes' };

/** A buyer deal's homes: their facts, how each fits, what the clients said, and adding one (from the MLS too). */
export default async function RealestateHomesPage({
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
    // Homes to look at are a buyer deal's; a listing has none.
    if (deal.deal.side !== 'buyer') notFound();
    const [homes, suggestions, matches] = await Promise.all([
      api.POST('/v1/queries/realestate.homes', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.suggestions', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/realestate.matches', {
          body: { workspaceId, dealId, state: 'new' },
        })
        .then(unwrapPage),
    ]);
    return (
      <HomesPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        homes={homes.homes}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        agentName={deal.team.find((t) => t.main)?.name ?? null}
        suggestions={suggestions.suggestions}
        feed={{
          connected: matches.search.feedConnected,
          newMatches: matches.counts.new,
          searchOn: matches.search.on,
        }}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
