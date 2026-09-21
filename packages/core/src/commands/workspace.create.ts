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
    if (!ws) throw HfosError.internal('workspace insert returned no row');
    /*
     * The creator joins as an owner, the way the bootstrap function does for the workspace made at
     * sign-up. Administering the organization is what lets someone run this command; it does not make
     * them a member of the workspace, and nearly everything inside one is scoped to its members, so a
     * workspace with nobody on it has nobody to show, book or assign, and no way in from the app.
     *
     * Through `private.add_workspace_owner` rather than an insert here: `app.workspace_memberships` has
     * no insert policy, by design, so the two existing ways in are `security definer` functions too.
     */
    const [owner] = await rows<{ add_workspace_owner: string }>(
      ctx.tx,
      sql`select private.add_workspace_owner(${ws.id})`,
    );
    if (!owner?.add_workspace_owner)
      throw HfosError.internal('add_workspace_owner returned no membership');
    await ctx.emit({
      type: 'workspace.created',
      entityType: 'workspace',
      entityId: ws.id,
      workspaceId: ws.id,
      payload: { name: input.name, slug, timezone: input.timezone, industry: input.industry },
      after: { name: input.name, slug, timezone: input.timezone, industry: input.industry },
    });
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
