import { asc, eq } from 'drizzle-orm';
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
    return {
      members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
      organizationAdmins: orgPeople.filter((p) => !directIds.has(p.userId)),
    };
  },
});
