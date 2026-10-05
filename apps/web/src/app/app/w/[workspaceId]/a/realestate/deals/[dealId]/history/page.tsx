import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { HistoryPage } from '@/addons/realestate/history-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Deal history' };

/** Everything that happened on a deal, newest first, with who did it. */
export default async function RealestateHistoryPage({
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
        .POST('/v1/queries/realestate.deal.history', { body: { workspaceId, dealId, limit: 200 } })
        .then(unwrapPage),
    ]);
    return (
      <HistoryPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        lines={history.lines}
      />
    );
  });
}
