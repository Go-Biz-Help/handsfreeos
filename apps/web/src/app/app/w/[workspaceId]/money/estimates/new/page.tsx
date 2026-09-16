import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { DocumentEditor } from '@/components/money/document-editor';
import { blankDraft } from '@/components/money/draft';
import { MoneyCrumbs } from '@/components/money/subnav';
import { loadEditorCatalogs, loadMoneyShell } from '../../load';
import { seedFrom } from '../../seed';

export const metadata: Metadata = { title: 'New estimate' };

/** A new estimate. `?person=` and `?lead=` prefill it, so "New estimate" from a lead lands ready to write. */
export default async function NewEstimatePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const shell = await loadMoneyShell(workspaceId);
  if (!shell.canManage) notFound();
  const [{ products, connections }, seed] = await Promise.all([
    loadEditorCatalogs(shell.api, workspaceId),
    seedFrom(shell.api, workspaceId, await searchParams),
  ]);

  return (
    <>
      <MoneyCrumbs workspaceId={workspaceId} tab="estimates" current="New estimate" />
      <DocumentEditor
        workspaceId={workspaceId}
        kind="estimate"
        documentId={null}
        revision={0}
        initial={blankDraft('estimate', shell.settings, connections, seed)}
        settings={shell.settings}
        products={products}
        connections={connections}
        timeZone={shell.timeZone}
        nextNumber={shell.nextEstimateNumber}
      />
    </>
  );
}
