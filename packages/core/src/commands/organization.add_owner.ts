import { rows, sql } from '@hfos/db/client';
import { addOrganizationOwner } from '../account/ownership';
import { HfosError } from '../errors';
import { requireHuman } from '../kernel/actor';
import { defineCommand } from '../kernel/define';
import { OrganizationAddOwnerInput, OrganizationAddOwnerOutput } from '../schemas/organization';

/**
 * Handing an agency over (M10): an owner of an organization makes someone else an owner of it, so they can delete their
 * own account without leaving it ownerless. Only someone who already owns one of its businesses (or is an admin of the
 * organization) can be made its owner, because an organization's owner reaches every business in it. Recorded in each
 * of its businesses: each one learns who can reach it now, and none learns about the others.
 */
export const organizationAddOwner = defineCommand({
  name: 'organization.add_owner',
  description:
    'Make someone an owner of your organization (an agency and all its businesses). They must already own one of its businesses. Use it to hand an agency over before you leave.',
  risk: 4,
  input: OrganizationAddOwnerInput,
  output: OrganizationAddOwnerOutput,
  permission: 'org.members.manage',
  scope: (i) => ({ kind: 'organization', organizationId: i.organizationId }),
  emits: ['organization.owner_added'],
  async handler(ctx, input) {
    const me = requireHuman(ctx).userId;
    const [org] = await rows<{ name: string }>(
      ctx.tx,
      sql`select name from app.organizations where id = ${input.organizationId}`,
    );
    if (!org) throw HfosError.notFound('Organization not found.');
    if (input.userId === me)
      throw HfosError.rule('own_role', 400, `You’re an owner of ${org.name} already.`);
    const [person] = await rows<{
      full_name: string;
      email: string;
      org_role: 'owner' | 'admin' | null;
      owns: number;
    }>(
      ctx.tx,
      sql`select u.full_name, u.email::text as email,
            (select om.role::text from app.organization_memberships om
             where om.organization_id = ${input.organizationId} and om.user_id = u.id) as org_role,
            (select count(*) from app.workspace_memberships wm join app.workspaces w on w.id = wm.workspace_id
             where w.organization_id = ${input.organizationId} and wm.user_id = u.id and wm.role = 'owner')::int as owns
          from app.users u
          where u.id = ${input.userId} and u.deleted_at is null`,
    );
    const known = person && (person.org_role !== null || person.owns > 0);
    // Someone who works elsewhere doesn't exist here, whatever the reason.
    const inOrganization = person
      ? (
          await rows(
            ctx.tx,
            sql`select 1 from app.workspace_memberships wm join app.workspaces w on w.id = wm.workspace_id
                where w.organization_id = ${input.organizationId} and wm.user_id = ${input.userId}
                union all
                select 1 from app.organization_memberships om
                where om.organization_id = ${input.organizationId} and om.user_id = ${input.userId}
                limit 1`,
          )
        ).length > 0
      : false;
    if (!person || !inOrganization)
      throw HfosError.notFound(`That person isn’t part of ${org.name}.`);
    const name = person.full_name.trim() || person.email;
    if (person.org_role === 'owner')
      return {
        organizationId: input.organizationId,
        userId: input.userId,
        previousRole: 'owner' as const,
        changed: false,
      };
    if (!known)
      throw HfosError.rule(
        'not_a_business_owner',
        409,
        `Make ${name} an owner of one of ${org.name}’s businesses first, in its Members page. Only someone who already owns one of them can be made an owner of ${org.name}.`,
      );
    const previous = await addOrganizationOwner(ctx.tx, input.organizationId, input.userId);
    const businesses = await rows<{ id: string }>(
      ctx.tx,
      sql`select id from app.workspaces where organization_id = ${input.organizationId} order by created_at`,
    );
    for (const b of businesses)
      await ctx.emit({
        type: 'organization.owner_added',
        entityType: 'user',
        entityId: input.userId,
        workspaceId: b.id,
        payload: { userId: input.userId, from: previous },
        before: { role: previous },
        after: { role: 'owner', organization: org.name },
      });
    return {
      organizationId: input.organizationId,
      userId: input.userId,
      previousRole: previous,
      changed: previous !== 'owner',
    };
  },
});
