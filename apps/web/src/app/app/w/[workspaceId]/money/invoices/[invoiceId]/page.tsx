import type { Metadata } from 'next';
import { DocumentEditor } from '@/components/money/document-editor';
import { InvoiceDocument } from '@/components/money/document-page';
import { draftOfInvoice } from '@/components/money/draft';
import { MoneyCrumbs } from '@/components/money/subnav';
import { unwrapPage } from '@/lib/api/server';
import { loadEditorCatalogs, loadMoneyShell } from '../../load';

export const metadata: Metadata = { title: 'Invoice' };

/** One invoice: the editor while it is a draft, and the document — with its payments — once it has gone out. */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ workspaceId: string; invoiceId: string }>;
}) {
  const { workspaceId, invoiceId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  const [data, catalogs] = await Promise.all([
    shell.api
      .POST('/v1/queries/invoice.get', { body: { workspaceId, invoiceId } })
      .then((r) => unwrapPage(r)),
    loadEditorCatalogs(shell.api, workspaceId),
  ]);
  const inv = data.invoice;
  const editable = shell.canManage && inv.status === 'draft' && !inv.sentAt;

  if (!editable)
    return (
      <InvoiceDocument
        workspaceId={workspaceId}
        data={data}
        canManage={shell.canManage}
        timeZone={shell.timeZone}
        now={shell.now}
      />
    );

  return (
    <>
      <MoneyCrumbs workspaceId={workspaceId} tab="invoices" current="Draft" />
      <DocumentEditor
        workspaceId={workspaceId}
        kind="invoice"
        documentId={inv.id}
        revision={inv.revision}
        initial={draftOfInvoice(inv, shell.settings)}
        settings={shell.settings}
        products={catalogs.products}
        connections={catalogs.connections}
        timeZone={shell.timeZone}
        nextNumber={shell.nextInvoiceNumber}
        startedBy={inv.assignee?.fullName ?? null}
        startedAt={inv.createdAt}
      />
    </>
  );
}
