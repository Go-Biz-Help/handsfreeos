import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AiSetupBoard } from '@/components/agency/ai-setups';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'AI setups' };

/** Quick setup answers the agency saved, which its businesses start their AI teammate from. */
export default async function AgencyAiSetupsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await getMe();
  const org = agencyOrganizations(me).find((o) => o.id === orgId);
  if (!org) notFound();
  const setups = unwrapPage(
    await api.POST('/v1/queries/ai_setup_template.list', { body: { organizationId: orgId } }),
  );
  return (
    <AiSetupBoard
      organizationId={orgId}
      setups={setups.items}
      businesses={orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }))}
    />
  );
}
