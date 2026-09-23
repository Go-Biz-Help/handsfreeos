import { asc, eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { organizationMemberships, users, workspaceMemberships } from '@hfos/db/schema';
import { defineQuery } from '../kernel/define';
import { WorkspaceMembersInput, WorkspaceMembersOutput } from '../schemas/membership';

export const workspaceMembers = defineQuery({
  name: 'workspace.members',
  description:
    'Everyone in a workspace, plus organization admins who reach it without a direct membership.',
  input: WorkspaceMembersInput,
  output: WorkspaceMembersOutput,
  permission: 'members.read',
  scope: (i) => ({ kind: 'workspace', workspaceId: i.workspaceId }),
  async handler(ctx, input) {
    const members = await ctx.tx
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        role: workspaceMemberships.role,
        joinedAt: workspaceMemberships.createdAt,
      })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, input.workspaceId))
      .orderBy(asc(workspaceMemberships.createdAt));
    const directIds = new Set(members.map((m) => m.userId));
    // Visible only to organization members (RLS); client staff get an empty list by design.
    const orgPeople = await ctx.tx
      .select({
        userId: users.id,
        email: users.email,
        fullName: users.fullName,
        avatarUrl: users.avatarUrl,
        orgRole: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(users, eq(users.id, organizationMemberships.userId))
      .where(eq(organizationMemberships.organizationId, ctx.scope.organizationId!))
      .orderBy(asc(organizationMemberships.createdAt));
    // What each of them may do here (0103), as the database keeps it.
    const granted = new Map(
      (
        await rows<{ user_id: string; permissions: string[] }>(
          ctx.tx,
          sql`select user_id, permissions from private.workspace_member_permissions(${input.workspaceId}::uuid)`,
        )
      ).map((r) => [r.user_id, r.permissions]),
    );
    return {
      members: members.map((m) => ({
        ...m,
        permissions: granted.get(m.userId) ?? [],
        joinedAt: m.joinedAt.toISOString(),
      })),
      organizationAdmins: orgPeople
        .filter((p) => !directIds.has(p.userId))
        .map((p) => ({ ...p, permissions: granted.get(p.userId) ?? [] })),
    };
  },
});
