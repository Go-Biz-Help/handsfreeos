import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DocumentsPage } from '@/addons/realestate/documents-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Documents' };

/** A deal's documents, their versions, and the files on it that aren't documents yet. */
export default async function RealestateDocumentsPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
}) {
  const { workspaceId, dealId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [deal, documents, files] = await Promise.all([
      api
        .POST('/v1/queries/realestate.deal.get', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.document.list', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
    ]);
    return (
      <DocumentsPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
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
