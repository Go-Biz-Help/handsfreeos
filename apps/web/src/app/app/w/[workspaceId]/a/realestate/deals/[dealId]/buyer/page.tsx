import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { BuyerPage } from '@/addons/realestate/buyer-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'What they want' };

/** What a buyer wants: the AI's suggestions to confirm, what's confirmed, and the profile homes are checked against. */
export default async function RealestateBuyerPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, profile, memory] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.buyer_profile.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.memory', inDeal).then(unwrapPage),
    ]);
    return (
      <BuyerPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        profile={profile.profile}
        memory={memory}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
