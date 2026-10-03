import type { Metadata } from 'next';
import { addonPage } from '@/addons/gate';
import { DocumentsPage } from '@/addons/realestate/documents-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Documents' };

/**
 * A deal's documents, their versions, and the files on it that aren't documents yet; a contract's reading too, and
 * what's out for signing (round five). DocuSign and Dotloop send the agent back here with `?esign=<envelope>`.
 * Round six: the whole transaction's exports, for whoever may export (`realestate.export`).
 */
export default async function RealestateDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; dealId: string }>;
  searchParams: Promise<{ esign?: string | string[] }>;
}) {
  const { workspaceId, dealId } = await params;
  const { esign: back } = await searchParams;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [got, deal, documents, files, reads, esign] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
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
      api
        .POST('/v1/queries/realestate.contract.reads', { body: { workspaceId, dealId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/realestate.esign.list', { body: { workspaceId, dealId } })
        .then(unwrapPage),
    ]);
    const canExport = got.workspace.permissions.includes('realestate.export');
    const exports = canExport
      ? await api
          .POST('/v1/queries/realestate.exports', { body: { workspaceId, dealId } })
          .then(unwrapPage)
      : null;
    // Who might sign: the deal's people, with the email each would sign with.
    const people = await Promise.all(
      deal.parties
        .filter((p) => p.personId)
        .map(async (p) => {
          const got = await api.POST('/v1/queries/person.get', {
            body: { workspaceId, personId: p.personId! },
          });
          return {
            name: p.name,
            email: got.data?.person.email ?? null,
            label: p.label,
            client: p.role === 'client',
          };
        }),
    );
    return (
      <DocumentsPage
        workspaceId={workspaceId}
        dealId={dealId}
        dealName={deal.deal.name}
        documents={documents.documents}
        timeZone={got.workspace.timezone}
        files={files.files.map((f) => ({
          id: f.id,
          name: f.name,
          bucket: f.bucket,
          objectPath: f.objectPath,
          sizeBytes: f.sizeBytes,
        }))}
        exports={exports ? exports.exports : null}
        reads={reads.reads}
        esign={esign}
        people={people}
        back={typeof back === 'string' ? back : null}
      />
    );
  });
}
