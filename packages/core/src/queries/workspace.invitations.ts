import { and, desc, eq, isNull } from 'drizzle-orm';
import { invitations, users } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { WorkspaceInvitationsInput, WorkspaceInvitationsOutput } from '../schemas/invitation';

export const workspaceInvitations = defineQuery({
  name: 'workspace.invitations',
  description: 'Pending invitations for a workspace.',
  input: WorkspaceInvitationsInput,
  output: WorkspaceInvitationsOutput,
  permission: 'invitations.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const list = await ctx.tx
      .select({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        invitedById: invitations.invitedBy,
        inviterName: users.fullName,
        sentAt: invitations.sentAt,
        expiresAt: invitations.expiresAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .orderBy(desc(invitations.createdAt));
    return {
      invitations: list.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedBy: i.invitedById ? { userId: i.invitedById, fullName: i.inviterName ?? '' } : null,
        sentAt: i.sentAt ? i.sentAt.toISOString() : null,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    };
  },
});
