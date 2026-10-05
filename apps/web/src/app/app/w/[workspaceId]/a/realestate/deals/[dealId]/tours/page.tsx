import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { ToursPage } from '@/addons/realestate/tours-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Tours' };

/** A buyer deal's tours, and planning one (`?plan=1`). */
export default async function RealestateToursPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const deal = await api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage);
    // Tours are a buyer deal's; a listing has open houses instead.
    if (deal.deal.side !== 'buyer') notFound();
    const [got, tours, homes, calendars] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/realestate.tours', {
          body: { workspaceId, dealId, includeCanceled: true },
        })
        .then(unwrapPage),
      api.POST('/v1/queries/realestate.homes', inDeal).then(unwrapPage),
      api.POST('/v1/queries/calendar.list', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <ToursPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        tours={tours}
        homes={homes.homes}
        calendars={calendars.items
          .filter((c) => c.status === 'active')
          .map((c) => ({ id: c.id, name: c.name }))}
        team={deal.team.map((t) => ({ userId: t.userId, name: t.name, main: t.main }))}
        clients={deal.parties
          .filter((p) => p.role === 'client' && p.personId)
          .map((p) => ({ personId: p.personId!, name: p.name }))}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
