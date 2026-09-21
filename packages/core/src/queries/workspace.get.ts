import { and, count, eq, isNull } from 'drizzle-orm';
import { invitations, organizations, workspaceMemberships, workspaces } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { WorkspaceGetInput, WorkspaceGetOutput } from '../schemas/workspace';

export const workspaceGet = defineQuery({
  name: 'workspace.get',
  description: 'One workspace with your role and a few counts.',
  input: WorkspaceGetInput,
  output: WorkspaceGetOutput,
  permission: 'workspace.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const [row] = await ctx.tx
      .select({ ws: workspaces, organizationName: organizations.name })
      .from(workspaces)
      .innerJoin(organizations, eq(organizations.id, workspaces.organizationId))
      .where(eq(workspaces.id, input.workspaceId));
    if (!row) throw HfosError.notFound('Workspace not found.');
    const [members] = await ctx.tx
      .select({ n: count() })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, input.workspaceId));
    const [pending] = await ctx.tx
      .select({ n: count() })
      .from(invitations)
      .where(
        and(
          eq(invitations.workspaceId, input.workspaceId),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      );
    return {
      workspace: {
        id: row.ws.id,
        organizationId: row.ws.organizationId,
        organizationName: row.organizationName,
        name: row.ws.name,
        slug: row.ws.slug,
        timezone: row.ws.timezone,
        industry: row.ws.industry,
        role: ctx.scope.workspaceRole ?? 'member',
        settings: row.ws.settings,
        inboxPerPerson:
          (
            (row.ws.settings as Record<string, unknown> | null)?.['inbox'] as
              { perPerson?: unknown } | undefined
          )?.perPerson === true,
        createdAt: row.ws.createdAt.toISOString(),
      },
      counts: { members: Number(members?.n ?? 0), pendingInvitations: Number(pending?.n ?? 0) },
    };
  },
});
