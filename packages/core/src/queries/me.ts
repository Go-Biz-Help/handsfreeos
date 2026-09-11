import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { organizationMemberships, organizations, users } from '@hfos/db/schema';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { MeInput, MeOutput } from '../schemas/user';

export const me = defineQuery({
  name: 'account.me',
  description:
    'Your profile plus every organization and workspace you can reach, with your role in each.',
  input: MeInput,
  output: MeOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx) {
    const [user] = await ctx.tx.select().from(users).where(eq(users.id, ctx.actor.userId));
    if (!user) throw HfosError.notFound('Profile not found.');
    const orgs = await ctx.tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(eq(organizationMemberships.userId, ctx.actor.userId))
      .orderBy(organizations.name);
    const wss = await rows<{
      id: string;
      organization_id: string;
      organization_name: string;
      name: string;
      slug: string;
      timezone: string;
      industry: string;
      role: 'owner' | 'admin' | 'member';
    }>(
      ctx.tx,
      sql`select w.id, w.organization_id, o.name as organization_name, w.name, w.slug, w.timezone, w.industry, private.effective_workspace_role(w.id)::text as role
          from app.workspaces w join app.organizations o on o.id = w.organization_id order by o.name, w.name`,
    );
    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
        settings: user.settings,
        createdAt: user.createdAt.toISOString(),
      },
      organizations: orgs,
      workspaces: wss.map((w) => ({
        id: w.id,
        organizationId: w.organization_id,
        organizationName: w.organization_name,
        name: w.name,
        slug: w.slug,
        timezone: w.timezone,
        industry: w.industry,
        role: w.role,
      })),
    };
  },
});
