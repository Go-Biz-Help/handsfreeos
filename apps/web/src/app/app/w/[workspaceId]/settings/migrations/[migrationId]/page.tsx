import { can } from '@hfos/core';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MigrationWizard } from '@/components/migrations/wizard';
import { PageHeader } from '@/components/shell/page-header';
import { loadMigration } from '@/lib/agency/migrations';
import { apiServer, getWorkspaceShell } from '@/lib/api/server';

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
  // The business as the shell draws it: the person's own, one they view as a teammate (20261018000100), or one
  // the founder is working in as its owner (20261013002100), which is never in their own list of businesses.
  const shell = await getWorkspaceShell(workspaceId);
  const current = shell.current;
  // A support look reads nothing here (the migration queries refuse it), so it gets the 404 page, as before.
  if (shell.viewingAs && !shell.viewingAs.acting && !shell.teammateView) notFound();
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
