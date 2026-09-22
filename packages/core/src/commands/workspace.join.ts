import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { WorkspaceJoinInput, WorkspaceJoinOutput } from '../schemas/workspace';
import { requireHuman } from '../kernel/actor';

/**
 * The other half of the choice `workspace.create` asks: put yourself on a business you administer.
 *
 * Somebody who set a business up for a client, and has since taken it on themselves, has no way onto it
 * otherwise — an invitation has to be sent by a member, and a business set up this way has none. Leaving
 * again is `membership.remove`, which already lets anyone take themselves off.
 *
 * `private.add_workspace_owner` does the writing and the checking: it refuses anyone who does not
 * administer the organization the workspace belongs to, and adds nobody but the caller.
 */
export const workspaceJoin = defineCommand({
  name: 'workspace.join',
  description:
    'Put yourself on a business in an organization you administer, as an owner. For one set up for a client and since taken on.',
  risk: 1,
  input: WorkspaceJoinInput,
  output: WorkspaceJoinOutput,
  permission: null,
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  emits: ['membership.created'],
  async handler(ctx, input) {
    const userId = requireHuman(ctx).userId;
    const [joined] = await rows<{ add_workspace_owner: string }>(
      ctx.tx,
      sql`select private.add_workspace_owner(${input.workspaceId})`,
    );
    if (!joined?.add_workspace_owner)
      throw HfosError.internal('add_workspace_owner returned no membership');
    await ctx.emit({
      type: 'membership.created',
      entityType: 'workspace_membership',
      entityId: userId,
      workspaceId: input.workspaceId,
      payload: { userId, role: 'owner', via: 'workspace_join' },
      after: { role: 'owner' },
    });
    return { workspaceId: input.workspaceId, role: 'owner' as const };
  },
});
