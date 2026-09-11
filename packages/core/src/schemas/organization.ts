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
