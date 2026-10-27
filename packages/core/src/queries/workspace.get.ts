import { and, count, eq, isNull } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { invitations, organizations, workspaceMemberships, workspaces } from '@hfos/db/schema';
import { ADDON_CATALOG } from '../addons/catalog';
import { currentCapabilityIds } from '../addons/capabilities';
import { loadActiveAddons } from '../addons/load';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { businessOnboardingOf } from '../onboarding/settings';
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
    if (!row)
      throw HfosError.notFound(
        'That business isn’t there, or you’re no longer in it. Pick a business from your list.',
      );
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
    const addons = await loadActiveAddons(ctx.tx, input.workspaceId);
    const permissions = [...(ctx.scope.workspacePermissions ?? [])];
    // Whether it still has to pick a founding spot and pay (20261027012700), asked of the database like account.me.
    const [plan] = await rows<{ needs_plan: boolean }>(
      ctx.tx,
      sql`select private.workspace_needs_plan(${input.workspaceId}::uuid) as needs_plan`,
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
        permissions,
        addons,
        settings: row.ws.settings,
        gettingStarted: !businessOnboardingOf(row.ws.settings as Record<string, unknown> | null)
          .turnedOff,
        needsPlan: plan?.needs_plan ?? false,
        inboxPerPerson:
          (
            (row.ws.settings as Record<string, unknown> | null)?.['inbox'] as
              { perPerson?: unknown } | undefined
          )?.perPerson === true,
        createdAt: row.ws.createdAt.toISOString(),
        capabilities: currentCapabilityIds({
          catalog: ADDON_CATALOG,
          // Running is all "current" asks, and active_addons has already applied HandsFreeOS's switches.
          installations: Object.fromEntries(addons.map((id) => [id, 'enabled' as const])),
          permissions,
        }),
      },
      counts: { members: Number(members?.n ?? 0), pendingInvitations: Number(pending?.n ?? 0) },
    };
  },
});
