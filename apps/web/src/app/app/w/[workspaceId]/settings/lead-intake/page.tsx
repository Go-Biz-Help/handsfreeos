import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LeadIntakeSettings } from '@/components/settings/lead-intake-page';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Lead intake' };

/**
 * Settings → Lead intake (owners and admins): what happens when a stranger texts, calls or emails, and
 * where the leads that opens land.
 */
export default async function LeadIntakeSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const body = { body: { workspaceId } };
  const [got, intake] = await Promise.all([
    api.POST('/v1/queries/workspace.get', body).then(unwrapPage),
    api.POST('/v1/queries/intake.list', body).then(unwrapPage),
  ]);
  const role = got.workspace.role;
  if (role !== 'owner' && role !== 'admin') notFound();
  return (
    <>
      <PageHeader
        title="Lead intake"
        description="Leads that arrive on their own, without anybody typing them in."
      />
      <SettingsNav workspaceId={workspaceId} canManage />
      <LeadIntakeSettings
        workspaceId={workspaceId}
        sources={intake.sources}
        pipelines={intake.pipelines}
      />
    </>
  );
}
