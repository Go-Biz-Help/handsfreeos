import { can } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiServer, unwrapPage } from '@/lib/api/server';
import { formatDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Imports' };

const STATUS: Record<string, { label: string; variant: 'ok' | 'pending' | 'revoked' | 'gray' }> = {
  pending: { label: 'Waiting', variant: 'pending' },
  running: { label: 'Running', variant: 'pending' },
  done: { label: 'Done', variant: 'ok' },
  failed: { label: 'Failed', variant: 'revoked' },
  cancelled: { label: 'Cancelled', variant: 'gray' },
};

export default async function ImportsSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'records.import')) notFound();
  const { imports } = unwrapPage(
    await api.POST('/v1/queries/import.list', { body: { workspaceId } }),
  );
  return (
    <>
      <PageHeader
        section
        title="Imports"
        description="Customer lists brought in from a spreadsheet, each with how it went."
        actions={
          <ButtonLink href={`/app/w/${workspaceId}/imports/new`} variant="primary">
            Import a spreadsheet
          </ButtonLink>
        }
      />
      <Card className="overflow-hidden" data-testid="imports-list">
        {imports.length === 0 ? (
          <EmptyState title="No imports yet">
            Bring in an existing customer list from a CSV; every run is kept here with its result.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-card-2 text-left text-xs font-medium text-text-2">
                  <th className="px-4 py-2.5">File</th>
                  <th className="px-3 py-2.5">Kind</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Result</th>
                  <th className="px-3 py-2.5">Started</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((i) => (
                  <tr key={i.id} className="border-t border-border hover:bg-card-2/60">
                    <td className="px-4 py-2.5">
                      <Link
                        href={`/app/w/${workspaceId}/imports/${i.id}`}
                        className="font-medium text-accent-text hover:underline"
                      >
                        {i.fileName}
                      </Link>
                      <span className="block text-xs text-text-3">
                        by {i.createdBy?.fullName ?? 'a former member'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[13px]">
                      {i.kind === 'people' ? 'People' : 'Companies'}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS[i.status]?.variant ?? 'gray'}>
                        {STATUS[i.status]?.label ?? i.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-text-2">
                      {i.status === 'pending'
                        ? '—'
                        : `${i.createdCount} added · ${i.updatedCount} updated · ${i.skippedCount} skipped · ${i.errorCount} errors`}
                    </td>
                    <td className="px-3 py-2.5 text-[13px] text-text-2">
                      {formatDate(i.createdAt, { time: true })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
