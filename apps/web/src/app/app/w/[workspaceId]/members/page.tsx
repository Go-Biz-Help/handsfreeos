import { can } from '@hfos/core';
import type { Metadata } from 'next';
import { InviteDialog } from '@/components/members/invite-dialog';
import { MembersTable } from '@/components/members/members-table';
import { OrgAdmins } from '@/components/members/org-admins';
import { PendingInvitations } from '@/components/members/pending-invitations';
import { PageHeader } from '@/components/shell/page-header';
import { apiServer, unwrapPage } from '@/lib/api/server';

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
  const got = unwrapPage(await api.POST('/v1/queries/workspace.get', { body: { workspaceId } }));
  const myRole = got.workspace.role;
  const mine = got.workspace.permissions;
  const seesInvitations = can(mine, 'invitations.read');
  // An owner sets what each person may do (0106) from here, so they get everyone's settings.
  const setsPermissions = can(mine, 'permissions.manage');
  const [members, invitations, permissionSettings] = await Promise.all([
    api.POST('/v1/queries/workspace.members', { body: { workspaceId } }).then(unwrapPage),
    seesInvitations
      ? api.POST('/v1/queries/workspace.invitations', { body: { workspaceId } }).then(unwrapPage)
      : Promise.resolve({ invitations: [] }),
    setsPermissions
      ? api.POST('/v1/queries/permission.settings', { body: { workspaceId } }).then(unwrapPage)
      : Promise.resolve(null),
  ]);
  return (
    <>
      <PageHeader
        title="Members"
        description={`People who can work in ${got.workspace.name}.${members.organizationAdmins.length ? ` Owners and admins of ${got.workspace.organizationName} also have access.` : ''}`}
        actions={
          can(mine, 'members.invite') ? (
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
        myPermissions={mine}
        myUserId={userId}
        inboxPerPerson={got.workspace.inboxPerPerson}
        permissionSettings={permissionSettings}
        openPermissionsFor={typeof sp.permissions === 'string' ? sp.permissions : null}
      />
      {members.organizationAdmins.length > 0 ? (
        <OrgAdmins
          workspaceId={workspaceId}
          people={members.organizationAdmins}
          organizationName={got.workspace.organizationName}
          myUserId={userId}
          canJoin={!members.members.some((m) => m.userId === userId)}
        />
      ) : null}
      {seesInvitations ? (
        <PendingInvitations
          workspaceId={workspaceId}
          invitations={invitations.invitations}
          canResend={can(mine, 'members.invite')}
          canRevoke={can(mine, 'invitations.revoke')}
        />
      ) : null}
    </>
  );
}
