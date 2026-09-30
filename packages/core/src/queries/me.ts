import { eq } from 'drizzle-orm';
import { rows, sql } from '@hfos/db/client';
import { organizationMemberships, organizations, users } from '@hfos/db/schema';
import { assistantConsentOf } from '../assistant/consent';
import { HfosError } from '../errors';
import { defineQuery } from '../kernel/define';
import { MeInput, MeOutput } from '../schemas/user';
import { requireHuman } from '../kernel/actor';

export const me = defineQuery({
  name: 'account.me',
  description:
    'Your profile plus every organization and workspace you can reach, with your role and what you may do in each.',
  input: MeInput,
  output: MeOutput,
  permission: null,
  scope: () => ({ kind: 'account' }),
  async handler(ctx) {
    const [user] = await ctx.tx
      .select()
      .from(users)
      .where(eq(users.id, requireHuman(ctx).userId));
    if (!user)
      throw HfosError.notFound(
        'Your account’s profile is missing. Sign out and sign back in to set it up again.',
      );
    const orgs = await ctx.tx
      .select({
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        role: organizationMemberships.role,
      })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizations.id, organizationMemberships.organizationId))
      .where(eq(organizationMemberships.userId, requireHuman(ctx).userId))
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
      permissions: string[];
      addons: string[];
      getting_started: boolean;
    }>(
      ctx.tx,
      // The businesses this person works in. Support staff can see every business's name (M13), so the
      // filter is written here rather than left to the read rules: this list is "yours", not "visible".
      sql`select w.id, w.organization_id, o.name as organization_name, w.name, w.slug, w.timezone, w.industry, private.effective_workspace_role(w.id)::text as role,
            private.my_permissions(w.id) as permissions, private.active_addons(w.id) as addons,
            (w.settings -> 'onboarding' -> 'turnedOff') is null as getting_started
          from app.workspaces w join app.organizations o on o.id = w.organization_id
          where private.effective_workspace_role(w.id) is not null
          order by o.name, w.name`,
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
        permissions: w.permissions,
        addons: w.addons,
        gettingStarted: w.getting_started,
      })),
      // What the Assistant panels read before the first question (the same answer the worker enforces).
      assistantConsent: assistantConsentOf(user.settings),
    };
  },
});
