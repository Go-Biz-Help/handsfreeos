import type { CommandDef } from '../kernel/types';
import { invitationAccept } from './invitation.accept';
import { invitationResend } from './invitation.resend';
import { invitationRevoke } from './invitation.revoke';
import { membershipChangeRole } from './membership.change_role';
import { membershipInvite } from './membership.invite';
import { membershipRemove } from './membership.remove';
import { organizationCreate } from './organization.create';
import { userUpdateProfile } from './user.update_profile';
import { workspaceCreate } from './workspace.create';
import { workspaceUpdate } from './workspace.update';

export {
  invitationAccept,
  invitationResend,
  invitationRevoke,
  membershipChangeRole,
  membershipInvite,
  membershipRemove,
  organizationCreate,
  userUpdateProfile,
  workspaceCreate,
  workspaceUpdate,
};
export { hashInvitationToken } from './invitation.accept';
export { INVITATION_TTL_MS } from './membership.invite';

/** Explicit list on purpose: greppable, bundler-safe, and the order the docs list them in. */
export const commands: readonly CommandDef[] = [
  organizationCreate,
  workspaceCreate,
  workspaceUpdate,
  membershipInvite,
  invitationResend,
  invitationRevoke,
  invitationAccept,
  membershipChangeRole,
  membershipRemove,
  userUpdateProfile,
] as unknown as readonly CommandDef[];
