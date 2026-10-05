import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { ShowingsPage } from '@/addons/realestate/showings-page';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Showings' };

/** A listing's showings (round five): from its page and ShowingTime's emails, what buyers said, and how they work. */
export default async function RealestateShowingsPage({
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
    // Showings are a listing's; a buyer's tours are their own page.
    if (deal.deal.side !== 'listing') notFound();
    const [list, brandedOrigin] = await Promise.all([
      api.POST('/v1/queries/realestate.showing.list', inDeal).then(unwrapPage),
      brandedOriginFor(api, workspaceId),
    ]);
    return (
      <ShowingsPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        list={list}
        live={!deal.deal.outcome && !deal.deal.archived}
        brandedOrigin={brandedOrigin}
      />
    );
  });
}
