import { and, eq, isNull } from 'drizzle-orm';
import { invitations, users, workspaceMemberships } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { canActOnRole } from '../permissions';
import { MembershipInviteInput, MembershipInviteOutput } from '../schemas/membership';
import { requireHuman } from '../kernel/actor';
import { assertMayGrantRole } from './role-grant';

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const membershipInvite = defineCommand({
  name: 'membership.invite',
  description:
    'Invite someone to a workspace by email. They receive a single-use link that expires in 7 days.',
  risk: 2,
  input: MembershipInviteInput,
  output: MembershipInviteOutput,
  permission: 'members.invite',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['invitation.created'],
  async handler(ctx, input) {
    if (!canActOnRole(ctx.scope.workspaceRole, input.role)) {
      throw HfosError.forbidden(
        'You can only invite people at your own role or below.',
        'cannot_grant_role',
      );
    }
    await assertMayGrantRole(ctx, input.role);
    const [member] = await ctx.tx
      .select({ id: workspaceMemberships.id })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(
        and(eq(workspaceMemberships.workspaceId, input.workspaceId), eq(users.email, input.email)),
      );
    if (member)
      throw HfosError.conflict(
        'That person is already a member of this workspace.',
        'already_member',
      );
    const [pending] = await ctx.tx
      .select({ id: invitations.id })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          eq(invitations.email, input.email),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    if (pending)
      throw HfosError.conflict(
        'An invitation is already pending for this address.',
        'invitation_pending',
      );

    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
    const [inv] = await ctx.tx
      .insert(invitations)
      .values({
        organizationId: ctx.scope.organizationId!,
        workspaceId: input.workspaceId,
        email: input.email,
        role: input.role,
        invitedBy: requireHuman(ctx).userId,
        expiresAt,
      })
      .returning({
        id: invitations.id,
        email: invitations.email,
        role: invitations.role,
        expiresAt: invitations.expiresAt,
      });
    if (!inv) throw HfosError.forbidden();
    await ctx.emit({
      type: 'invitation.created',
      entityType: 'invitation',
      entityId: inv.id,
      payload: { email: inv.email, role: inv.role, invitedBy: requireHuman(ctx).userId },
      after: { email: inv.email, role: inv.role, expiresAt },
    });
    return {
      invitationId: inv.id,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt.toISOString(),
    };
  },
});
