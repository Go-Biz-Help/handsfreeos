import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { ContingenciesPage } from '@/addons/realestate/contingencies-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Contingencies' };

/** A deal's contingencies (round four, board 52): when each ends, and how each ended, with the signed form. */
export default async function RealestateContingenciesPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const inDeal = { body: { workspaceId, dealId } };
    const [deal, list, documents, files] = await Promise.all([
      api.POST('/v1/queries/realestate.deal.get', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.contingencies', inDeal).then(unwrapPage),
      api.POST('/v1/queries/realestate.document.list', inDeal).then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
    ]);
    return (
      <ContingenciesPage
        workspaceId={workspaceId}
        deal={deal}
        list={list}
        documents={documents.documents}
        files={files.files.map((f) => ({
          id: f.id,
          name: f.name,
          bucket: f.bucket,
          objectPath: f.objectPath,
        }))}
      />
    );
  });
}
