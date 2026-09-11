import { and, eq, isNull } from 'drizzle-orm';
import { invitations } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { InvitationResendInput, InvitationResendOutput } from '../schemas/invitation';

export const invitationResend = defineCommand({
  name: 'invitation.resend',
  description: 'Send a pending invitation again with a fresh link; the old link stops working.',
  risk: 2,
  input: InvitationResendInput,
  output: InvitationResendOutput,
  permission: 'members.invite',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['invitation.resend_requested'],
  async handler(ctx, input) {
    const [inv] = await ctx.tx
      .select({ id: invitations.id, email: invitations.email, role: invitations.role })
      .from(invitations)
      .where(
        and(
          eq(invitations.id, input.invitationId),
          eq(invitations.workspaceId, input.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    if (!inv) throw HfosError.notFound('No pending invitation with that id.');
    await ctx.emit({
      type: 'invitation.resend_requested',
      entityType: 'invitation',
      entityId: inv.id,
      payload: { email: inv.email, role: inv.role },
      after: { email: inv.email, role: inv.role, status: 'resent' },
    });
    return { invitationId: inv.id, email: inv.email };
  },
});
