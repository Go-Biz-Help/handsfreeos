import { can } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MigrationWizard } from '@/components/migrations/wizard';
import { PageHeader } from '@/components/shell/page-header';
import { loadMigration } from '@/lib/agency/migrations';
import { apiServer, getMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Migration' };

/**
 * One migration, as this business sees it: its own sub-account, its own counts, its own choices. An agency
 * opening the same migration from the agency area sees every business in it; this page shows one, because a
 * business has no business seeing another's.
 */
export default async function WorkspaceMigrationPage({
  params,
}: {
  params: Promise<{ workspaceId: string; migrationId: string }>;
}) {
  const { workspaceId, migrationId } = await params;
  const { api } = await apiServer();
  const me = await getMe();
  const current = me.workspaces.find((w) => w.id === workspaceId);
  if (!current) notFound();
  if (!can(current.permissions, 'migrations.manage')) notFound();

  const detail = await loadMigration(api, current.organizationId, migrationId, workspaceId);
  if (!detail?.migration) notFound();

  return (
    <>
      <PageHeader
        section
        title={detail.migration.name}
        description={
          <>
            Moving {current.name} here from {detail.migration.sourceLabel}.{' '}
            <Link
              href={`/app/w/${workspaceId}/settings/migrations`}
              className="text-accent-text hover:underline"
            >
              All migrations
            </Link>
          </>
        }
      />
      <MigrationWizard
        organizationId={current.organizationId}
        workspaceId={workspaceId}
        detail={detail}
        businesses={[{ id: workspaceId, name: current.name }]}
      />
    </>
  );
}
