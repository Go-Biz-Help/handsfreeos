import {
  StaffPage,
  type StaffInvitationView,
  type StaffMemberView,
} from '@/components/admin/staff-page';
import { apiServer, unwrap } from '@/lib/api/server';

export default async function SupportStaffPage() {
  const { api, userId } = await apiServer();
  const [list, me] = await Promise.all([
    api.POST('/v1/queries/support.staff.list', { body: {} }).then(unwrap),
    api.POST('/v1/queries/platform.me', { body: {} }).then(unwrap),
  ]);
  return (
    <StaffPage
      staff={list.staff as unknown as StaffMemberView[]}
      invitations={list.invitations as unknown as StaffInvitationView[]}
      canManage={me.staff?.permissions.includes('platform.staff.manage') ?? false}
      meUserId={userId}
      meDisplayName={me.staff?.displayName ?? ''}
      meSignature={me.staff?.signature ?? ''}
    />
  );
}
