import { z } from 'zod';
import { email, isoDateTime, uuid, workspaceRole } from './common';

export const MembershipInviteInput = z.object({
  workspaceId: uuid,
  email,
  role: workspaceRole.default('member'),
});
export const MembershipInviteOutput = z.object({
  invitationId: uuid,
  email: z.string(),
  role: workspaceRole,
  expiresAt: isoDateTime,
});

export const MembershipChangeRoleInput = z.object({
  workspaceId: uuid,
  userId: uuid,
  role: workspaceRole,
});
export const MembershipChangeRoleOutput = z.object({
  userId: uuid,
  previousRole: workspaceRole,
  role: workspaceRole,
});

export const MembershipRemoveInput = z.object({ workspaceId: uuid, userId: uuid });
export const MembershipRemoveOutput = z.object({ userId: uuid, left: z.boolean() });

export const Member = z.object({
  userId: uuid,
  email: z.string(),
  fullName: z.string(),
  avatarUrl: z.string().nullable(),
  role: workspaceRole,
  joinedAt: isoDateTime,
});
export type Member = z.infer<typeof Member>;

export const OrganizationPerson = z.object({
  userId: uuid,
  email: z.string(),
  fullName: z.string(),
  avatarUrl: z.string().nullable(),
  orgRole: z.enum(['owner', 'admin']),
});

export const WorkspaceMembersInput = z.object({ workspaceId: uuid });
export const WorkspaceMembersOutput = z.object({
  members: z.array(Member),
  /** Owners and admins of the organization who reach this workspace without a direct membership. */
  organizationAdmins: z.array(OrganizationPerson),
});
