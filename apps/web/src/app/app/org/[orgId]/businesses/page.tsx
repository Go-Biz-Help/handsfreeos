import { AGENCY_SETUP_WORDS } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AddClientBusiness, BusinessList } from '@/components/agency/businesses';
import { PageHeader } from '@/components/shell/page-header';
import { loadTemplates } from '@/lib/agency/load';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, getMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Client businesses' };

/** The agency's client businesses: how far each has got setting up, its templates and whether it's behind. */
export default async function AgencyBusinessesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await getMe();
  if (!agencyOrganizations(me).some((o) => o.id === orgId)) notFound();
  const businesses = orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }));
  const [templates, setup] = await Promise.all([
    loadTemplates(api, orgId),
    // A nicety: if HandsFreeOS can't say, the list shows without its Setup column.
    api
      .POST('/v1/queries/onboarding.clients', { body: { organizationId: orgId } })
      .then((r) => r.data ?? null)
      .catch(() => null),
  ]);
  return (
    <>
      <PageHeader
        title="Client businesses"
        description={
          setup
            ? `${AGENCY_SETUP_WORDS.summary(setup.counts.all, setup.counts.stuck, setup.counts.setup)}. Each business’s templates, the version it has, and whether it’s behind.`
            : 'Each business’s templates, the version it has, and whether it’s behind.'
        }
        actions={<AddClientBusiness organizationId={orgId} organizations={me.organizations} />}
      />
      <BusinessList
        organizationId={orgId}
        businesses={businesses}
        templates={templates}
        setup={setup}
      />
    </>
  );
}
