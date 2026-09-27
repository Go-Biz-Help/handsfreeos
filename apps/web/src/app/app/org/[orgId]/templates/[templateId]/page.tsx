import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TemplateEditor } from '@/components/agency/template-editor';
import { agencyOrganizations, orgBusinesses } from '@/lib/agency/org';
import { apiServer, getMe, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Template' };

const ID = /^[0-9a-f-]{36}$/i;

/** One agency template in the workflow editor, with where it's installed and its versions. */
export default async function AgencyTemplatePage({
  params,
}: {
  params: Promise<{ orgId: string; templateId: string }>;
}) {
  const { orgId, templateId } = await params;
  if (!ID.test(templateId)) notFound();
  const { api } = await apiServer();
  const me = await getMe();
  const org = agencyOrganizations(me).find((o) => o.id === orgId);
  if (!org) notFound();
  const data = unwrapPage(
    await api.POST('/v1/queries/workflow_template.get', {
      body: { organizationId: orgId, templateId },
    }),
  );
  const businesses = orgBusinesses(me, orgId);
  // Previews need a business's name and time zone; a template has none of its own.
  const sample = businesses[0];
  if (!sample) notFound();
  return (
    <TemplateEditor
      key={templateId}
      organizationId={orgId}
      data={data}
      businesses={businesses.map((b) => ({ id: b.id, name: b.name }))}
      sample={{ workspaceId: sample.id, businessName: sample.name, timeZone: sample.timezone }}
    />
  );
}
