import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ClientTasksPage } from '@/addons/realestate/client-tasks-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Client’s to-do' };

/** What a deal's clients do themselves in their portal, and letting them in (`?invite=1`). */
export default async function RealestateClientTasksPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [deal, data, files] = await Promise.all([
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.client_tasks', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
    ]);
    return (
      <ClientTasksPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        side={deal.deal.side}
        agentName={deal.team.find((t) => t.main)?.name ?? null}
        data={data}
        files={files.files.map((f) => ({ id: f.id, name: f.name }))}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
