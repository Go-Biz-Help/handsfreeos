import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PackBoard } from '@/components/agency/packs';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, fetchMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Knowledge packs' };

/** Starter knowledge the agency pushes to client businesses as suggestions. */
export default async function AgencyPacksPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const org = agencyOrganizations(me).find((o) => o.id === orgId);
  if (!org) notFound();
  const packs = unwrapPage(
    await api.POST('/v1/queries/knowledge_pack.list', {
      body: { organizationId: orgId, includeArchived: true },
    }),
  );
  return (
    <PackBoard
      organizationId={orgId}
      agencyName={org.name}
      packs={packs.items}
      businesses={orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }))}
    />
  );
}
