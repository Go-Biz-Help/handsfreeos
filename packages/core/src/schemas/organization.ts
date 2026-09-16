import { z } from 'zod';
import { displayName, industry, timezone, uuid } from './common';

export const OrganizationCreateInput = z.object({
  businessName: displayName,
  /** Defaults to the business name. Agencies name the organization after the agency. */
  organizationName: displayName.optional(),
  timezone: timezone.default('America/Chicago'),
  industry: industry.default('home_services'),
});
export type OrganizationCreateInput = z.input<typeof OrganizationCreateInput>;

export const OrganizationCreateOutput = z.object({ organizationId: uuid, workspaceId: uuid });
export type OrganizationCreateOutput = z.infer<typeof OrganizationCreateOutput>;

/**
 * Handing an organization over (M10): an owner of it makes someone who already owns one of its businesses (or an
 * admin of it) an owner of it too. An agency's owner does this before deleting their account; an organization holding
 * a single business passes to that business's other owners on its own.
 */
export const OrganizationAddOwnerInput = z.object({ organizationId: uuid, userId: uuid });
export const OrganizationAddOwnerOutput = z.object({
  organizationId: uuid,
  userId: uuid,
  /** Their role in the organization before: none, admin, or owner already (nothing changed). */
  previousRole: z.enum(['none', 'admin', 'owner']),
  changed: z.boolean(),
});
