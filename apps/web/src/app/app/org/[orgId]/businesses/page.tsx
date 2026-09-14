import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BusinessList } from '@/components/agency/businesses';
import { PageHeader } from '@/components/shell/page-header';
import { loadTemplates } from '@/lib/agency/load';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, fetchMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Client businesses' };

/** The agency's client businesses, each with its templates and whether it's behind. */
export default async function AgencyBusinessesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  if (!agencyOrganizations(me).some((o) => o.id === orgId)) notFound();
  const businesses = orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }));
  const templates = await loadTemplates(api, orgId);
  return (
    <>
      <PageHeader
        title="Client businesses"
        description="Each business’s templates, the version it has, and whether it’s behind."
      />
      <BusinessList organizationId={orgId} businesses={businesses} templates={templates} />
    </>
  );
}
