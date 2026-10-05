import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { ClientUpdate } from '@/addons/realestate/client-update';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Client update' };

/** A client update drafted from the deal's facts: checked for fair-housing risk, edited and sent by the agent. */
export default async function RealestateClientUpdatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string; draftId: string }>;
}) {
  const { workspaceId, dealId, draftId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [deal, data] = await Promise.all([
      api
        .POST('/v1/queries/realestate.deal.get', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.status_email.get', { body: { workspaceId, draftId } })
        .then(unwrapPage),
    ]);
    if (data.draft.dealId !== dealId) notFound();
    return (
      <ClientUpdate
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        data={data}
      />
    );
  });
}
