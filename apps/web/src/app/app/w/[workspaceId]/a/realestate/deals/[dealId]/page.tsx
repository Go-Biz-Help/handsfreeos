import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DealPage } from '@/addons/realestate/deal-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Deal' };

/**
 * One deal, and a duty on it in the drawer (`?duty=<id>`): where every alert about the deal opens. A deal the person
 * isn't on and can't see is the business's not-found page, like any record they can't see. A buyer deal also shows
 * the buyer's side: what they want, their homes and tours, the agreement, financing, their to-do, offers and CMAs.
 */
export default async function RealestateDealPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, risks, drafts, members] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.risks', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.status_email.list', inDeal).then(unwrapPage),
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    ]);
    const buyer =
      deal.deal.side === 'buyer'
        ? await Promise.all([
            api.POST('/v1/queries/realestate.buyer_profile.get', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.memory', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.homes', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.tours', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.financing', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.client_tasks', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.offers', inDeal).then(unwrapPage),
            api.POST('/v1/queries/realestate.cmas', inDeal).then(unwrapPage),
          ]).then(([profile, memory, homes, tours, financing, tasks, offers, cmas]) => ({
            profile: profile.profile,
            memory,
            homes: homes.homes,
            tours,
            financing,
            tasks,
            offers: offers.offers,
            cmas: cmas.cmas,
          }))
        : null;
    return (
      <DealPage
        workspaceId={workspaceId}
        timeZone={got.workspace.timezone}
        deal={deal}
        risks={risks}
        drafts={drafts.drafts}
        members={assigneeOptions(members)}
        canManage={got.workspace.permissions.includes('realestate.manage')}
        buyer={buyer}
      />
    );
  });
}
