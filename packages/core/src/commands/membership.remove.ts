import { and, eq } from 'drizzle-orm';
import { workspaceMemberships } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { canActOnRole } from '../permissions';
import { MembershipRemoveInput, MembershipRemoveOutput } from '../schemas/membership';

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
    const leaving = input.userId === ctx.actor.userId;
    const [target] = await ctx.tx
      .select({ id: workspaceMemberships.id, role: workspaceMemberships.role })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.userId, input.userId),
        ),
      );
    if (!target) throw HfosError.notFound('That person is not a member of this workspace.');
    if (!leaving) {
      const role = ctx.scope.workspaceRole;
      const mayRemove = role === 'owner' || role === 'admin';
      if (!mayRemove || !canActOnRole(role, target.role))
        throw HfosError.forbidden(
          'You can only remove people at your own level or below.',
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
