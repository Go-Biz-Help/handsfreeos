import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { addonPage } from '@/addons/gate';
import { ContractPage } from '@/addons/realestate/contract-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Contract' };

/**
 * A contract, amendment or addendum as it was read (round four, boards 50 and 51): the PDF beside each value with
 * its clause and page, waiting for a person to confirm it, and what an amendment moves.
 */
export default async function RealestateContractPage({
  params,
}: {
  params: Promise<{ workspaceId: string; dealId: string; readId: string }>;
}) {
  const { workspaceId, dealId, readId } = await params;
  return addonPage(workspaceId, 'realestate', 'realestate.use', async () => {
    const { api } = await apiServer();
    const [got, read, files] = await Promise.all([
      api.POST('/v1/queries/workspace.get', { body: { workspaceId } }).then(unwrapPage),
      api
        .POST('/v1/queries/realestate.contract.read', { body: { workspaceId, readId } })
        .then(unwrapPage),
      api
        .POST('/v1/queries/file.list', {
          body: { workspaceId, recordType: 'custom_record', recordId: dealId },
        })
        .then(unwrapPage),
    ]);
    if (read.dealId !== dealId) notFound();
    const file = files.files.find((f) => f.id === read.fileId);
    return (
      <ContractPage
        workspaceId={workspaceId}
        timeZone={got.workspace.timezone}
        read={read}
        file={
          file
            ? { id: file.id, name: file.name, bucket: file.bucket, objectPath: file.objectPath }
            : null
        }
      />
    );
  });
}
