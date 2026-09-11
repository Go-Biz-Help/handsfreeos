import type { QueryDef } from '../kernel/types';
import { auditList } from './audit.list';
import { invitationPreview } from './invitation.preview';
import { me } from './me';
import { workspaceGet } from './workspace.get';
import { workspaceInvitations } from './workspace.invitations';
import { workspaceMembers } from './workspace.members';

export { auditList, invitationPreview, me, workspaceGet, workspaceInvitations, workspaceMembers };

export const queries: readonly QueryDef[] = [
  me,
  workspaceGet,
  workspaceMembers,
  workspaceInvitations,
  invitationPreview,
  auditList,
] as unknown as readonly QueryDef[];
