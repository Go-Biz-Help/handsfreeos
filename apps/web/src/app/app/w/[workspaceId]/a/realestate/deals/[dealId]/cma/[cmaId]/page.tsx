import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { CmaPage } from '@/addons/realestate/cma-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'CMA' };

/** One CMA on a buyer deal: its comps, range, summary, fair-housing checks and sharing. */
export default async function RealestateCmaPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string; cmaId: string }>;
}) {
  const { workspaceId, dealId, cmaId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [deal, cma] = await Promise.all([
      api
        .POST('/v1/queries/realestate.deal.get', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api.POST('/v1/queries/realestate.cma', { body: { workspaceId, cmaId } }).then(unwrapPage),
    ]);
    return (
      <CmaPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        cma={cma.cma}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
      />
    );
  });
}
