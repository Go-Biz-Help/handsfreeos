import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DatesPage } from '@/addons/realestate/dates-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Key dates' };

/** A deal's key dates and terms, each with its source and history. */
export default async function RealestateDatesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [got, deal, history] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/realestate.deal.get', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.term.history', { body: { workspaceId, dealId } })
        .then(unwrapPage),
    ]);
    return (
      <DatesPage
        workspaceId={workspaceId}
        timeZone={got.workspace.timezone}
        deal={deal}
        history={history}
      />
    );
  });
}
