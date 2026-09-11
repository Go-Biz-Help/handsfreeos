import { and, eq, isNull } from 'drizzle-orm';
import { invitations } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { InvitationRevokeInput, InvitationRevokeOutput } from '../schemas/invitation';
import { requireHuman } from '../kernel/actor';

export const invitationRevoke = defineCommand({
  name: 'invitation.revoke',
  description: 'Cancel a pending invitation so its link no longer works.',
  risk: 2,
  input: InvitationRevokeInput,
  output: InvitationRevokeOutput,
  permission: 'invitations.revoke',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['invitation.revoked'],
  async handler(ctx, input) {
    const [inv] = await ctx.tx
      .update(invitations)
      .set({ revokedAt: new Date(), revokedBy: requireHuman(ctx).userId })
      .where(
        and(
          eq(invitations.id, input.invitationId),
          eq(invitations.workspaceId, input.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning({ id: invitations.id, email: invitations.email, role: invitations.role });
    if (!inv) throw HfosError.notFound('No pending invitation with that id.');
    await ctx.emit({
      type: 'invitation.revoked',
      entityType: 'invitation',
      entityId: inv.id,
      payload: { email: inv.email },
      before: { status: 'pending', email: inv.email },
      after: { status: 'revoked', email: inv.email },
    });
    return { invitationId: inv.id, email: inv.email };
  },
});
