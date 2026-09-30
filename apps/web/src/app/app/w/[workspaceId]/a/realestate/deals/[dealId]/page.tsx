import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DealPage } from '@/addons/realestate/deal-page';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Deal' };

/**
 * One deal, and a duty on it in the drawer (`?duty=<id>`): where every alert about the deal opens. A deal the person
 * isn't on and can't see is the business's not-found page, like any record they can't see.
 */
export default async function RealestateDealPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [got, deal, risks, drafts, members] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/realestate.deal.get', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.deal.risks', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.status_email.list', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    ]);
    return (
      <DealPage
        workspaceId={workspaceId}
        timeZone={got.workspace.timezone}
        deal={deal}
        risks={risks}
        drafts={drafts.drafts}
        members={assigneeOptions(members)}
        canManage={got.workspace.permissions.includes('realestate.manage')}
      />
    );
  });
}
