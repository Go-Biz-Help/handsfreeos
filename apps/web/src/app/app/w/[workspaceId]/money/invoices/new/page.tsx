import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocumentEditor } from '@/components/money/document-editor';
import { blankDraft } from '@/components/money/draft';
import { MoneyCrumbs } from '@/components/money/subnav';
import { loadEditorCatalogs, loadMoneyShell } from '../../load';
import { seedFrom } from '../../seed';

export const metadata: Metadata = { title: 'New invoice' };

/** A new invoice. `?person=` and `?lead=` prefill it, the same way the estimate's does. */
export default async function NewInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  if (!shell.canBill) notFound();
  const [{ products, connections }, seed] = await Promise.all([
    loadEditorCatalogs(shell.api, workspaceId),
    seedFrom(shell.api, workspaceId, await searchParams),
  ]);

  return (
    <>
      <MoneyCrumbs workspaceId={workspaceId} tab="invoices" current="New invoice" />
      <DocumentEditor
        workspaceId={workspaceId}
        kind="invoice"
        documentId={null}
        revision={0}
        initial={blankDraft('invoice', shell.settings, connections, seed)}
        settings={shell.settings}
        products={products}
        connections={connections}
        timeZone={shell.timeZone}
        nextNumber={shell.nextInvoiceNumber}
      />
    </>
  );
}
