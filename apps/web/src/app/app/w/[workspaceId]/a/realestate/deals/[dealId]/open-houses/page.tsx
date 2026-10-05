import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { OpenHousesPage } from '@/addons/realestate/open-houses-page';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { brandedOriginFor } from '@/lib/hosting/branded-origin';

export const metadata: Metadata = { title: 'Open houses' };

/** A listing's open houses, who signed in at each, and planning one (`?plan=1`). */
export default async function RealestateOpenHousesPage({
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
    const [{ listing }, list, calendars, brandedOrigin] = await Promise.all([
      api.POST('/v1/queries/realestate.listing', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.open_houses', inDeal).then(unwrapPage),
      api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage),
      brandedOriginFor(api, workspaceId),
    ]);
    return (
      <OpenHousesPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        street={listing.street ?? deal.deal.name}
        timeZone={got.workspace.timezone}
        list={list}
        sellers={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        calendars={calendars.items
          .filter((c) => c.status === 'active')
          .map((c) => ({ id: c.id, name: c.name }))}
        team={deal.team.map((t) => ({ userId: t.userId, name: t.name, main: t.main }))}
        brandedOrigin={brandedOrigin}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
