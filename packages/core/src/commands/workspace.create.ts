import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { workspaces } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { WorkspaceCreateInput, WorkspaceCreateOutput } from '../schemas/workspace';
import { slugify } from '../slug';
import { requireHuman } from '../kernel/actor';

export const workspaceCreate = defineCommand({
  name: 'workspace.create',
  description: 'Add another business (workspace) to an organization you administer.',
  risk: 1,
  input: WorkspaceCreateInput,
  output: WorkspaceCreateOutput,
  permission: 'workspace.create',
  scope: (i) => ({ kind: 'organization', organizationId: i.organizationId }),
  emits: ['workspace.created', 'membership.created'],
  async handler(ctx, input) {
    const slug = `${slugify(input.name)}-${randomUUID().slice(0, 6)}`;
    const [ws] = await ctx.tx
      .insert(workspaces)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        slug,
        timezone: input.timezone,
        industry: input.industry,
        createdBy: requireHuman(ctx).userId,
      })
      .returning({ id: workspaces.id });
    if (!ws)
      throw HfosError.internal('Your business couldn’t be set up just now. Try again in a minute.');
    /*
     * A business you run yourself puts you on it; one you set up for a client does not, and while
     * nobody is on it the organization's owners and admins hear about it instead. Either way the
     * creator can open and change everything, which comes from administering the organization.
     *
     * Through `private.add_workspace_owner` rather than an insert here: `app.workspace_memberships`
     * has no insert policy, by design, so the two other ways in are `security definer` functions too.
     */
    if (input.joinAsOwner) {
      const [owner] = await rows<{ add_workspace_owner: string }>(
        ctx.tx,
        sql`select private.add_workspace_owner(${ws.id})`,
      );
      if (!owner?.add_workspace_owner)
        throw HfosError.internal(
          'Your business was made, but you weren’t added to it. Try again in a minute, or ask HandsFreeOS support.',
        );
    }
    await ctx.emit({
      type: 'workspace.created',
      entityType: 'workspace',
      entityId: ws.id,
      workspaceId: ws.id,
      payload: { name: input.name, slug, timezone: input.timezone, industry: input.industry },
      after: { name: input.name, slug, timezone: input.timezone, industry: input.industry },
    });
    if (input.joinAsOwner)
      await ctx.emit({
        type: 'membership.created',
        entityType: 'workspace_membership',
        entityId: requireHuman(ctx).userId,
        organizationId: input.organizationId,
        workspaceId: ws.id,
        payload: { userId: requireHuman(ctx).userId, role: 'owner', via: 'workspace_create' },
        after: { role: 'owner' },
      });
    return { workspaceId: ws.id, slug };
  },
});
