import { and, eq } from 'drizzle-orm';
import { workspaceMemberships } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { scopeCan } from '../kernel/execute';
import { canActOnRole, missingPermissionMessage } from '../permissions';
import { MembershipRemoveInput, MembershipRemoveOutput } from '../schemas/membership';
import { requireHuman } from '../kernel/actor';
import { aRole, whoCan } from './membership.change_role';

export const membershipRemove = defineCommand({
  name: 'membership.remove',
  description: 'Remove a teammate from a workspace, or leave it yourself.',
  risk: 3,
  input: MembershipRemoveInput,
  output: MembershipRemoveOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['membership.removed'],
  async handler(ctx, input) {
    const leaving = input.userId === requireHuman(ctx).userId;
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
        leaving
          ? 'You’re not in this business anymore, so there’s nothing to leave.'
          : 'That person isn’t in this business anymore. They may have left or been removed. Refresh the Members page.',
      );
    if (!leaving) {
      // Removing someone else is `members.remove`, as the business has set it up (0106), and only at their own
      // level or below; anyone may leave.
      const role = ctx.scope.workspaceRole;
      const mayRemove = scopeCan(ctx.scope, 'members.remove');
      if (!mayRemove)
        throw HfosError.forbidden(
          missingPermissionMessage('members.remove', role),
          'cannot_remove_role',
        );
      if (!canActOnRole(role, target.role))
        throw HfosError.forbidden(
          `Only ${whoCan(target.role)} can remove ${aRole(target.role)}. Ask one of them.`,
          'cannot_remove_role',
        );
    }
    // Recorded before the delete on purpose: someone leaving loses the right to write the workspace's
    // event a statement later. The transaction still makes it all-or-nothing.
    await ctx.emit({
      type: 'membership.removed',
      entityType: 'workspace_membership',
      entityId: input.userId,
      payload: { userId: input.userId, role: target.role, left: leaving },
      before: { role: target.role },
      after: null,
    });
    const [row] = await ctx.tx
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.id, target.id))
      .returning({ id: workspaceMemberships.id });
    if (!row) throw HfosError.forbidden();
    return { userId: input.userId, left: leaving };
  },
});
