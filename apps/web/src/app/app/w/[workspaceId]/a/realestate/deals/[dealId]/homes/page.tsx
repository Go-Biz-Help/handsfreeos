import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { HomesPage } from '@/addons/realestate/homes-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Homes' };

/** A buyer deal's homes: their facts, how each fits, what the clients said, and adding one. */
export default async function RealestateHomesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, homes] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.homes', inDeal).then(unwrapPage),
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
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
