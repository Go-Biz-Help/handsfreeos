import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmailPage } from '@/components/settings/email-page';
import { SettingsNav } from '@/components/settings/settings-nav';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Email' };

/** Owners and admins set up the workspace's sending address, its own domain and connected mailboxes here. */
export default async function EmailSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const canManage = got.workspace.role === 'owner' || got.workspace.role === 'admin';
  if (!canManage) notFound();
  const [status, blocked, unmatched, tags] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/email.setup_status', { body: { workspaceId } })),
    unwrapPage(
      await api.POST('/v1/queries/email_suppression.list', { body: { workspaceId, limit: 50 } }),
    ),
    unwrapPage(
      await api.POST('/v1/queries/email.unmatched_list', { body: { workspaceId, limit: 50 } }),
    ),
    unwrapPage(await api.POST('/v1/queries/tag.list', { body: { workspaceId } })),
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Your account, and how this workspace is set up." />
      <SettingsNav workspaceId={workspaceId} canManage />
      <EmailPage
        workspaceId={workspaceId}
        workspaceName={got.workspace.name}
        status={status}
        blocked={blocked.items}
        unmatched={unmatched.items}
        tags={tags.tags}
      />
    </>
  );
}
