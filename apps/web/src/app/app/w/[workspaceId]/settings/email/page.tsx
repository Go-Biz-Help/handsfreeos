import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmailPage } from '@/components/settings/email-page';
import { apiServer, unwrapPage } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Email' };

/** Owners and admins set up the workspace's sending address, its own domain and connected mailboxes here. */
export default async function EmailSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  // Coming back from Microsoft's or Google's sign-in: how it went.
  const { mailbox } = await searchParams;
  const { api } = await apiServer();
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  if (!can(got.workspace.permissions, 'channels.manage')) notFound();
  const [status, blocked, unmatched, tags] = await Promise.all([
    api.POST('/v1/queries/email.setup_status', { body: { workspaceId } }).then(unwrapPage),
    api
      .POST('/v1/queries/email_suppression.list', { body: { workspaceId, limit: 50 } })
      .then(unwrapPage),
    api
      .POST('/v1/queries/email.unmatched_list', { body: { workspaceId, limit: 50 } })
      .then(unwrapPage),
    api.POST('/v1/queries/tag.list', { body: { workspaceId } }).then(unwrapPage),
  ]);
  return (
    <>
      <EmailPage
        workspaceId={workspaceId}
        workspaceName={got.workspace.name}
        status={status}
        blocked={blocked.items}
        unmatched={unmatched.items}
        tags={tags.tags}
        mailboxResult={typeof mailbox === 'string' ? mailbox : null}
      />
    </>
  );
}
