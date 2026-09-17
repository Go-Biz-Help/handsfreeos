import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MigrationWizard } from '@/components/migrations/wizard';
import { PageHeader } from '@/components/shell/page-header';
import { loadMigration } from '@/lib/agency/migrations';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, fetchMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Migration' };

/** One migration, one step at a time: where each sub-account lands, what to bring, the plan, and the result. */
export default async function MigrationPage({
  params,
}: {
  params: Promise<{ orgId: string; migrationId: string }>;
}) {
  const { orgId, migrationId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const org = agencyOrganizations(me).find((o) => o.id === orgId);
  if (!org) notFound();
  const detail = await loadMigration(api, orgId, migrationId);
  if (!detail?.migration) notFound();
  return (
    <>
      <PageHeader
        title={detail.migration.name}
        description={
          <>
            Moving {org.name} here from {detail.migration.sourceLabel}.{' '}
            <Link
              href={`/app/org/${orgId}/migrations`}
              className="text-accent-text hover:underline"
            >
              All migrations
            </Link>
          </>
        }
      />
      <MigrationWizard
        organizationId={orgId}
        detail={detail}
        businesses={orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }))}
      />
    </>
  );
}
