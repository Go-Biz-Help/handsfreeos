import { can } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ImportProgress } from '@/components/import/import-progress';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { formatDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Import' };

export default async function ImportPage({
  params,
}: {
  params: Promise<{ workspaceId: string; importId: string }>;
}) {
  const { workspaceId, importId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'records.import')) notFound();
  const initial = unwrapPage(
    await api.POST('/v1/queries/import.get', { body: { workspaceId, importId } }),
  );
  const imp = initial.import;
  return (
    <>
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px]">
        <Link href={`/app/w/${workspaceId}/customers`} className="text-accent-text hover:underline">
          Customers
        </Link>
        <span className="text-text-3">/</span>
        <span className="text-text-2">Import</span>
      </div>
      <PageHeader
        title={imp.fileName}
        description={`${imp.kind === 'people' ? 'People' : 'Companies'} · started ${formatDate(imp.createdAt, { time: true })} by ${imp.createdBy?.fullName ?? 'a former member'}`}
      />
      <div className="max-w-[980px]">
        <ImportProgress workspaceId={workspaceId} importId={importId} initial={initial} />
      </div>
    </>
  );
}
