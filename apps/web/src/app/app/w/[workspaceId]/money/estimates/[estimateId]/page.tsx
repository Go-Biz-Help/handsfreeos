import type { Metadata } from 'next';
import { DocumentEditor } from '@/components/money/document-editor';
import { EstimateDocument } from '@/components/money/document-page';
import { draftOfEstimate } from '@/components/money/draft';
import { MoneyCrumbs } from '@/components/money/subnav';
import { unwrapPage } from '@/lib/api/server';
import { loadEditorCatalogs, loadMoneyShell } from '../../load';

export const metadata: Metadata = { title: 'Estimate' };

/**
 * One estimate. While it is a draft and you may bill, it is the editor; once it has gone out it is the document
 * itself — what the customer was shown, what they did about it, and what to do next.
 */
export default async function EstimatePage({
  params,
}: {
  params: Promise<{ workspaceId: string; estimateId: string }>;
}) {
  const { workspaceId, estimateId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  const [data, catalogs] = await Promise.all([
    shell.api
      .POST('/v1/queries/estimate.get', { body: { workspaceId, estimateId } })
      .then((r) => unwrapPage(r)),
    loadEditorCatalogs(shell.api, workspaceId),
  ]);
  const est = data.estimate;
  const editable = shell.canBill && est.status === 'draft' && !est.sentAt;

  if (!editable)
    return (
      <EstimateDocument
        workspaceId={workspaceId}
        data={data}
        canBill={shell.canBill}
        connections={catalogs.connections}
        timeZone={shell.timeZone}
        now={shell.now}
      />
    );

  return (
    <>
      <MoneyCrumbs workspaceId={workspaceId} tab="estimates" current="Draft" />
      <DocumentEditor
        workspaceId={workspaceId}
        kind="estimate"
        documentId={est.id}
        revision={est.revision}
        initial={draftOfEstimate(est, shell.settings)}
        settings={shell.settings}
        products={catalogs.products}
        connections={catalogs.connections}
        timeZone={shell.timeZone}
        nextNumber={shell.nextEstimateNumber}
        startedBy={est.assignee?.fullName ?? null}
        startedAt={est.createdAt}
      />
    </>
  );
}
