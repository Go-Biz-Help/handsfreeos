import { randomUUID } from 'node:crypto';
import { workspaceMemberships, workspaces } from '@hfos/db/schema';
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
  emits: ['workspace.created'],
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
     * The creator joins as an owner, the way `private.bootstrap_*` does for the workspace made at sign-up.
     * Administering the organization is what lets someone run this command, but it does not make them a
     * member of the workspace, and almost everything inside one is scoped to its members: without this row
     * the business has nobody on it, so Calendar has nobody to show, nobody can be booked or assigned, and
     * there is no way in from the app to add the first person.
     */
    await ctx.tx
      .insert(workspaceMemberships)
      .values({ workspaceId: ws.id, userId: requireHuman(ctx).userId, role: 'owner' })
      .onConflictDoNothing();
    await ctx.emit({
      type: 'workspace.created',
      entityType: 'workspace',
      entityId: ws.id,
      workspaceId: ws.id,
      payload: { name: input.name, slug, timezone: input.timezone, industry: input.industry },
      after: { name: input.name, slug, timezone: input.timezone, industry: input.industry },
    });
    return { workspaceId: ws.id, slug };
  },
});
