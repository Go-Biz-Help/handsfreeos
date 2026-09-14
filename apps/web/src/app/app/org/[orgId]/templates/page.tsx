import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NewTemplateButton, TemplateList } from '@/components/agency/template-list';
import { PageHeader } from '@/components/shell/page-header';
import { loadTemplates } from '@/lib/agency/load';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, fetchMe } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Templates' };

/** The agency's workflow templates: versions, the businesses they're in, and who is behind. */
export default async function AgencyTemplatesPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { api } = await apiServer();
  const me = await fetchMe(api);
  const org = agencyOrganizations(me).find((o) => o.id === orgId);
  if (!org) notFound();
  const businesses = orgBusinesses(me, orgId).map((b) => ({ id: b.id, name: b.name }));
  const rows = await loadTemplates(api, orgId);
  return (
    <>
      <PageHeader
        title="Templates"
        description="Build a workflow once and push it to client businesses. Each gets a draft, which it tests and publishes itself."
        actions={
          rows.length ? (
            <NewTemplateButton
              organizationId={orgId}
              agencyName={org.name}
              businesses={businesses}
            />
          ) : null
        }
      />
      <TemplateList
        organizationId={orgId}
        agencyName={org.name}
        rows={rows}
        businesses={businesses}
      />
    </>
  );
}
