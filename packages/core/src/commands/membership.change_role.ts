import { and, eq } from 'drizzle-orm';
import { workspaceMemberships } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { canActOnRole, type WorkspaceRole } from '../permissions';
import { MembershipChangeRoleInput, MembershipChangeRoleOutput } from '../schemas/membership';
import { requireHuman } from '../kernel/actor';
import { assertMayGrantRole } from './role-grant';

/** Who may act on someone with `role`, or hand it out, in a refusal: that level and above. */
export const whoCan = (role: WorkspaceRole): string =>
  role === 'owner' ? 'owners' : 'owners and admins';

/** "an owner", "an admin", "a member". */
export const aRole = (role: WorkspaceRole): string =>
  role === 'member' ? 'a member' : `an ${role}`;

export const membershipChangeRole = defineCommand({
  name: 'membership.change_role',
  description: "Change a teammate's role in a workspace.",
  risk: 3,
  input: MembershipChangeRoleInput,
  output: MembershipChangeRoleOutput,
  permission: 'members.change_role',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['membership.role_changed'],
  async handler(ctx, input) {
    if (input.userId === requireHuman(ctx).userId)
      throw HfosError.forbidden(
        `You can’t change your own role. Ask ${ctx.scope.workspaceRole === 'owner' ? 'another owner' : 'an owner'} of this business to change it.`,
        'own_role',
      );
    const [target] = await ctx.tx
      .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.userId, input.userId),
        ),
      );
    if (!target)
      throw HfosError.notFound(
        'That person isn’t in this business anymore. They may have left or been removed. Refresh the Members page.',
      );
    if (!canActOnRole(ctx.scope.workspaceRole, target.role))
      throw HfosError.forbidden(
        `Only ${whoCan(target.role)} can change ${aRole(target.role)}’s role. Ask one of them.`,
        'cannot_grant_role',
      );
    if (!canActOnRole(ctx.scope.workspaceRole, input.role))
      throw HfosError.forbidden(
        `Only ${whoCan(input.role)} can make someone ${aRole(input.role)}. Pick a role at your level or below, or ask one of them.`,
        'cannot_grant_role',
      );
    if (target.role === input.role)
      return { userId: input.userId, previousRole: target.role, role: target.role };
    await assertMayGrantRole(ctx, input.role, input.userId);
    const [row] = await ctx.tx
      .update(workspaceMemberships)
      .set({ role: input.role })
      .where(eq(workspaceMemberships.id, target.id))
      .returning({ id: workspaceMemberships.id });
    if (!row) throw HfosError.forbidden();
    await ctx.emit({
      type: 'membership.role_changed',
      entityType: 'workspace_membership',
      entityId: input.userId,
      payload: { userId: input.userId, from: target.role, to: input.role },
      before: { role: target.role },
      after: { role: input.role },
    });
    return { userId: input.userId, previousRole: target.role, role: input.role };
  },
});
