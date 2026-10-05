import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { InspectionsPage } from '@/addons/realestate/inspections-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Inspections' };

/** A deal's inspections and the repair request: ours on a buyer deal, the buyers' on a listing. */
export default async function RealestateInspectionsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [got, deal, data, documents] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.inspections', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
    ]);
    // The deal's files, for the photos taken of what the inspection found.
    const files = data.inspections.some((i) => i.findings.some((f) => f.photoFileIds.length > 0))
      ? unwrapPage(
          await api.POST('/v1/queries/file.list', {
            body: { workspaceId, recordType: 'custom_record', recordId: dealId },
          }),
        ).files
      : [];
    return (
      <InspectionsPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        timeZone={got.workspace.timezone}
        data={data}
        documents={documents.documents}
        clients={deal.parties.filter((p) => p.role === 'client').map((p) => p.name)}
        live={!deal.deal.outcome && !deal.deal.archived}
        side={deal.deal.side}
        files={files}
      />
    );
  });
}
