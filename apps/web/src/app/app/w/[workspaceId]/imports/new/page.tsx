import { can } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ImportWizard } from '@/components/import/import-wizard';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Import contacts' };

export default async function NewImportPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'records.import')) notFound();
  return (
    <>
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={`/app/w/${workspaceId}/customers`} className="text-accent-text hover:underline">
          Contacts
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-text-2">Import</span>
      </div>
      <PageHeader
        title="Import contacts"
        description="Bring in an existing list from a spreadsheet. Nothing is saved until you press Run."
      />
      <ImportWizard workspaceId={workspaceId} />
    </>
  );
}
