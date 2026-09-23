import type { ReactNode } from 'react';
import { InboxShell } from '@/components/inbox/inbox-shell';
import { assigneeOptions } from '@/lib/api/people';
import { apiServer, unwrapPage } from '@/lib/api/server';

/** The list stays mounted while people move between conversations; each conversation is its own page. */
export default async function InboxLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { api, userId } = await apiServer();
  const [got, members] = await Promise.all([
    unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } })),
    unwrapPage(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
  ]);
  return (
    <InboxShell
      workspaceId={workspaceId}
      myUserId={userId}
      permissions={got.workspace.permissions}
      members={assigneeOptions(members)}
      timezone={got.workspace.timezone}
      narrowed={got.workspace.inboxPerPerson}
    >
      {children}
    </InboxShell>
  );
}
