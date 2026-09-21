import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BrandedDomainCard } from '@/components/settings/branded-domain-card';
import { SettingsNav } from '@/components/settings/settings-nav';
import { WorkspaceForm } from '@/components/settings/workspace-form';
import { PageHeader } from '@/components/shell/page-header';
import { Card } from '@/components/ui/card';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Workspace settings' };

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = got.workspace.role === 'owner' || got.workspace.role === 'admin';
  if (!canManage) notFound();
  // The domain lives here rather than under Calendars: it carries the forms, the estimates and the
  // payment links too, and nobody looking for "my own web address" thinks to open the booking site.
  const branded = unwrapPage(
    await api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } }),
  );
  return (
    <>
      <PageHeader title="Settings" description={`How ${got.workspace.name} is set up.`} />
      <SettingsNav workspaceId={workspaceId} canManage />
      <div className="flex flex-col gap-5">
        <Card className="p-6">
          <h2 className="text-lg font-semibold tracking-tight">Workspace</h2>
          <p className="mb-4 mt-1 text-[13px] text-text-2">
            Changes are recorded in the audit log.
          </p>
          <WorkspaceForm workspace={got.workspace} />
        </Card>
        <BrandedDomainCard workspaceId={workspaceId} domain={branded.domain} canManage />
      </div>
    </>
  );
}
