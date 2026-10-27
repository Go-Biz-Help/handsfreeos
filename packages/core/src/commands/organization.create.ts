import { randomUUID } from 'node:crypto';
import { rows, sql } from '@hfos/db/client';
import { HfosError } from '../errors';
import { defineCommand } from '../kernel/define';
import { OrganizationCreateInput, OrganizationCreateOutput } from '../schemas/organization';
import { slugify } from '../slug';

export const organizationCreate = defineCommand({
  name: 'organization.create',
  description: 'Create your organization and its first workspace. You become Owner of both.',
  risk: 1,
  input: OrganizationCreateInput,
  output: OrganizationCreateOutput,
  permission: null,
  scope: () => ({ kind: 'none' }),
  emits: ['organization.created', 'workspace.created', 'platform.affiliate_business_credited'],
  async handler(ctx, input) {
    const orgName = input.organizationName ?? input.businessName;
    const suffix = randomUUID().slice(0, 6);
    const orgSlug = `${slugify(orgName)}-${suffix}`;
    const wsSlug = `${slugify(input.businessName)}-${suffix}`;
    const [row] = await rows<{ org_id: string; ws_id: string }>(
      ctx.tx,
      sql`select * from private.create_organization(${orgName}, ${orgSlug}, ${input.businessName}, ${wsSlug}, ${input.timezone}, ${input.industry})`,
    );
    if (!row)
      throw HfosError.internal('Your business couldn’t be set up just now. Try again in a minute.');
    await ctx.emit({
      type: 'organization.created',
      entityType: 'organization',
      entityId: row.org_id,
      organizationId: row.org_id,
      workspaceId: null,
      payload: { name: orgName, slug: orgSlug },
      after: { name: orgName, slug: orgSlug },
    });
    await ctx.emit({
      type: 'workspace.created',
      entityType: 'workspace',
      entityId: row.ws_id,
      organizationId: row.org_id,
      workspaceId: row.ws_id,
      payload: {
        name: input.businessName,
        slug: wsSlug,
        timezone: input.timezone,
        industry: input.industry,
      },
      after: {
        name: input.businessName,
        slug: wsSlug,
        timezone: input.timezone,
        industry: input.industry,
      },
    });
    // Made through an affiliate's link: credited to them now, as it's made, or never (20261027014000). With no code
    // here, the function uses the link the account was made through. It answers null for a code that isn't an
    // approved affiliate's, or is the person's own, and never refuses.
    const how = input.affiliate?.how ?? 'link';
    const [credited] = await rows<{ affiliate_id: string | null }>(
      ctx.tx,
      sql`select private.affiliate_note_signup(${row.org_id}, ${input.affiliate?.code ?? null},
            ${how}, ${input.affiliate?.clickedAt ?? null}) as affiliate_id`,
    );
    if (credited?.affiliate_id)
      await ctx.emit({
        type: 'platform.affiliate_business_credited',
        entityType: 'organization',
        entityId: row.org_id,
        organizationId: row.org_id,
        workspaceId: row.ws_id,
        payload: { affiliateId: credited.affiliate_id, how },
      });
    return { organizationId: row.org_id, workspaceId: row.ws_id };
  },
});
