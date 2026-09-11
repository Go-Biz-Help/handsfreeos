import type { Metadata } from 'next';
import { InviteDialog } from '@/components/members/invite-dialog';
import { MembersTable } from '@/components/members/members-table';
import { OrgAdmins } from '@/components/members/org-admins';
import { PendingInvitations } from '@/components/members/pending-invitations';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrap } from '@/lib/api/server';

export const metadata: Metadata = { title: 'Members' };

export default async function MembersPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  const { api, userId } = await apiServer();
  const got = unwrap(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const myRole = got.workspace.role;
  const canManage = myRole === 'owner' || myRole === 'admin';
  const [members, invitations] = await Promise.all([
    unwrap(await api.POST('/v1/queries/workspace.members', { body: { workspaceId } })),
    canManage
      ? unwrap(await api.POST('/v1/queries/workspace.invitations', { body: { workspaceId } }))
      : Promise.resolve({ invitations: [] }),
  ]);
  return (
    <>
      <PageHeader
        title="Members"
        description={`People who can work in ${got.workspace.name}.${members.organizationAdmins.length ? ` Owners and admins of ${got.workspace.organizationName} also have access.` : ''}`}
        actions={
          canManage ? (
            <InviteDialog
              workspaceId={workspaceId}
              myRole={myRole}
              defaultOpen={sp.invite === '1'}
            />
          ) : null
        }
      />
      <MembersTable
        workspaceId={workspaceId}
        members={members.members}
        myRole={myRole}
        myUserId={userId}
      />
      {members.organizationAdmins.length > 0 ? (
        <OrgAdmins
          people={members.organizationAdmins}
          organizationName={got.workspace.organizationName}
        />
      ) : null}
      {canManage ? (
        <PendingInvitations workspaceId={workspaceId} invitations={invitations.invitations} />
      ) : null}
    </>
  );
}
