import { z } from 'zod';
import { isoDateTime, uuid, workspaceRole } from './common';

export const token = z.string().trim().min(16).max(128);

export const InvitationResendInput = z.object({ workspaceId: uuid, invitationId: uuid });
export const InvitationResendOutput = z.object({ invitationId: uuid, email: z.string() });

export const InvitationRevokeInput = z.object({ workspaceId: uuid, invitationId: uuid });
export const InvitationRevokeOutput = z.object({ invitationId: uuid, email: z.string() });

export const InvitationAcceptInput = z.object({ token });
export const InvitationAcceptOutput = z.object({
  invitationId: uuid,
  organizationId: uuid,
  workspaceId: uuid,
  role: workspaceRole,
});

export const PendingInvitation = z.object({
  id: uuid,
  email: z.string(),
  role: workspaceRole,
  invitedBy: z.object({ userId: uuid, fullName: z.string() }).nullable(),
  sentAt: isoDateTime.nullable(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
});
export type PendingInvitation = z.infer<typeof PendingInvitation>;

export const WorkspaceInvitationsInput = z.object({ workspaceId: uuid });
export const WorkspaceInvitationsOutput = z.object({ invitations: z.array(PendingInvitation) });

export const InvitationPreviewInput = z.object({ token });
export const InvitationPreviewOutput = z.object({
  status: z.enum(['pending', 'used', 'revoked', 'expired']),
  workspaceName: z.string(),
  organizationName: z.string(),
  role: workspaceRole,
  inviterName: z.string().nullable(),
  inviteeEmailMasked: z.string(),
  expiresAt: isoDateTime,
  emailMatches: z.boolean(),
});
