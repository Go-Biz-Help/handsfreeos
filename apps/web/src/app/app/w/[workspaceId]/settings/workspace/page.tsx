import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BrandedDomainCard } from '@/components/settings/branded-domain-card';
import { DeleteWorkspace } from '@/components/settings/delete-workspace';
import { GettingStartedSwitch } from '@/components/settings/getting-started-switch';
import { WorkspaceForm } from '@/components/settings/workspace-form';
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
  if (!can(got.workspace.permissions, 'workspace.update')) notFound();
  // The domain lives here rather than under Calendars: it carries the forms, the estimates and the
  // payment links too, and nobody looking for "my own web address" thinks to open the booking site.
  const branded = unwrapPage(
    await api.POST('/v1/queries/branded_domain.get', { body: { workspaceId } }),
  );
  return (
    <>
      <div className="flex flex-col gap-5">
        <Card className="p-6">
          <h2 className="text-lg font-semibold tracking-tight">Workspace</h2>
          <p className="mb-4 mt-1 text-[13px] text-text-2">
            Changes are recorded in the audit log.
          </p>
          <WorkspaceForm workspace={got.workspace} />
        </Card>
        {/* Getting started for everyone here: owners and admins can turn it off (workspace.update, as above). */}
        <GettingStartedSwitch workspaceId={workspaceId} enabled={got.workspace.gettingStarted} />
        {/* Adding the domain is setting up where the business is reached (channels.manage), as email's is. */}
        <BrandedDomainCard
          workspaceId={workspaceId}
          domain={branded.domain}
          canManage={can(got.workspace.permissions, 'channels.manage')}
        />
        {got.workspace.role === 'owner' ? (
          <Card className="p-6" id="delete-workspace">
            <DeleteWorkspace workspaceId={workspaceId} name={got.workspace.name} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
